#!/usr/bin/env python3
"""A small, dependency-free server file browser with HTTP range support."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import sqlite3
import tarfile
import zipfile
from datetime import datetime, timezone
from email.utils import formatdate
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, quote, unquote, urlparse


APP_DIR = Path(__file__).resolve().parent
RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)$")
mimetypes.add_type("application/yaml", ".yaml")
mimetypes.add_type("application/yaml", ".yml")
mimetypes.add_type("application/vnd.sqlite3", ".db")
mimetypes.add_type("application/vnd.sqlite3", ".sqlite")
mimetypes.add_type("application/vnd.sqlite3", ".sqlite3")
mimetypes.add_type("application/zip", ".zip")
mimetypes.add_type("application/x-tar", ".tar")


def human_type(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return mime


class FileViewerHandler(BaseHTTPRequestHandler):
    server_version = "NorthstarFiles/1.0"

    @property
    def root(self) -> Path:
        return self.server.files_root  # type: ignore[attr-defined]

    def send_json(self, value: object, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status: int, message: str) -> None:
        self.send_json({"error": message}, status)

    def safe_path(self, raw_path: str) -> Path:
        # Validate the URL path lexically instead of resolving it. This keeps
        # traversal attempts out while deliberately allowing symlinks that
        # live under the shared root to point to files elsewhere on the host.
        relative = PurePosixPath(unquote(raw_path))
        if relative.is_absolute() or ".." in relative.parts:
            raise PermissionError("路径超出共享目录")
        return self.root.joinpath(*relative.parts)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/files":
                self.list_files(parse_qs(parsed.query).get("path", [""])[0])
            elif parsed.path == "/api/meta":
                self.file_meta(parse_qs(parsed.query).get("path", [""])[0])
            elif parsed.path == "/api/database":
                self.database_data(parse_qs(parsed.query))
            elif parsed.path == "/api/archive":
                self.archive_data(parse_qs(parsed.query).get("path", [""])[0])
            elif parsed.path.startswith("/content/"):
                self.stream_file(parsed.path[len("/content/"):], inline=True)
            elif parsed.path.startswith("/download/"):
                self.stream_file(parsed.path[len("/download/"):], inline=False)
            elif parsed.path in ("/", "/index.html"):
                self.serve_asset("index.html")
            elif parsed.path in ("/app.js", "/styles.css"):
                self.serve_asset(parsed.path[1:])
            else:
                self.send_error_json(HTTPStatus.NOT_FOUND, "页面不存在")
        except PermissionError as exc:
            self.send_error_json(HTTPStatus.FORBIDDEN, str(exc))
        except FileNotFoundError:
            self.send_error_json(HTTPStatus.NOT_FOUND, "文件不存在")
        except OSError as exc:
            self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))

    def serve_asset(self, name: str) -> None:
        target = APP_DIR / "static" / name
        data = target.read_bytes()
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{mime}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def list_files(self, raw_path: str) -> None:
        directory = self.safe_path(raw_path)
        if not directory.is_dir():
            self.send_error_json(HTTPStatus.BAD_REQUEST, "这不是一个文件夹")
            return

        items = []
        try:
            children = sorted(
                directory.iterdir(),
                key=lambda p: (not p.is_dir(), p.name.casefold()),
            )
        except PermissionError:
            self.send_error_json(HTTPStatus.FORBIDDEN, "没有权限读取此文件夹")
            return

        for child in children:
            if child.name.startswith(".") and not self.server.show_hidden:  # type: ignore[attr-defined]
                continue
            try:
                stat = child.stat()
                is_dir = child.is_dir()
                rel = child.relative_to(self.root).as_posix()
                items.append({
                    "name": child.name,
                    "path": rel,
                    "kind": "folder" if is_dir else "file",
                    "mime": "inode/directory" if is_dir else human_type(child),
                    "size": None if is_dir else stat.st_size,
                    "modified": datetime.fromtimestamp(
                        stat.st_mtime, tz=timezone.utc
                    ).isoformat(),
                })
            except (OSError, PermissionError):
                continue

        rel_dir = directory.relative_to(self.root).as_posix()
        if rel_dir == ".":
            rel_dir = ""
        self.send_json({
            "path": rel_dir,
            "rootName": self.root.name or str(self.root),
            "items": items,
        })

    def file_meta(self, raw_path: str) -> None:
        path = self.safe_path(raw_path)
        stat = path.stat()
        self.send_json({
            "name": path.name,
            "path": path.relative_to(self.root).as_posix(),
            "mime": human_type(path),
            "size": stat.st_size,
            "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        })

    @staticmethod
    def sqlite_value(value: object) -> object:
        """Convert SQLite values to compact JSON-safe preview values."""
        if isinstance(value, bytes):
            return {"blob": True, "size": len(value), "preview": value[:16].hex()}
        if isinstance(value, str) and len(value) > 2000:
            return value[:2000] + "…"
        return value

    def database_data(self, query: dict[str, list[str]]) -> None:
        raw_path = query.get("path", [""])[0]
        table = query.get("table", [""])[0]
        try:
            page = max(1, int(query.get("page", ["1"])[0]))
            page_size = min(200, max(1, int(query.get("pageSize", ["50"])[0])))
        except ValueError:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "页码参数无效")
            return

        path = self.safe_path(raw_path)
        if not path.is_file():
            raise FileNotFoundError
        try:
            with path.open("rb") as file:
                if file.read(16) != b"SQLite format 3\x00":
                    self.send_error_json(HTTPStatus.BAD_REQUEST, "这不是有效的 SQLite 数据库")
                    return
        except OSError as exc:
            self.send_error_json(HTTPStatus.BAD_REQUEST, f"无法读取数据库：{exc}")
            return

        # URI read-only mode and query_only ensure previews can never mutate data.
        uri = f"{path.resolve().as_uri()}?mode=ro"
        try:
            with sqlite3.connect(uri, uri=True, timeout=3) as connection:
                connection.execute("PRAGMA query_only = ON")
                objects = connection.execute(
                    "SELECT name, type FROM sqlite_master "
                    "WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' "
                    "ORDER BY type, name COLLATE NOCASE"
                ).fetchall()
                tables = [{"name": name, "type": kind} for name, kind in objects]

                result: dict[str, object] = {
                    "path": raw_path,
                    "tables": tables,
                    "table": None,
                    "columns": [],
                    "rows": [],
                    "page": page,
                    "pageSize": page_size,
                    "total": 0,
                }
                if not tables:
                    self.send_json(result)
                    return

                valid_names = {item["name"] for item in tables}
                if not table:
                    table = tables[0]["name"]
                if table not in valid_names:
                    self.send_error_json(HTTPStatus.BAD_REQUEST, "数据表不存在")
                    return

                identifier = '"' + table.replace('"', '""') + '"'
                column_rows = connection.execute(f"PRAGMA table_info({identifier})").fetchall()
                columns = [
                    {
                        "name": row[1], "type": row[2] or "ANY",
                        "notNull": bool(row[3]), "primaryKey": bool(row[5]),
                    }
                    for row in column_rows
                ]
                total = connection.execute(f"SELECT COUNT(*) FROM {identifier}").fetchone()[0]
                offset = (page - 1) * page_size
                cursor = connection.execute(
                    f"SELECT * FROM {identifier} LIMIT ? OFFSET ?", (page_size, offset)
                )
                rows = [
                    [self.sqlite_value(value) for value in row]
                    for row in cursor.fetchall()
                ]
                result.update({
                    "table": table, "columns": columns, "rows": rows,
                    "total": total,
                })
                self.send_json(result)
        except sqlite3.DatabaseError as exc:
            self.send_error_json(HTTPStatus.BAD_REQUEST, f"数据库读取失败：{exc}")

    @staticmethod
    def archive_name(raw_name: str) -> str:
        """Return a display-safe relative archive member path."""
        parts = [
            part for part in raw_name.replace("\\", "/").split("/")
            if part not in ("", ".", "..")
        ]
        return "/".join(parts)

    def archive_data(self, raw_path: str) -> None:
        path = self.safe_path(raw_path)
        if not path.is_file():
            raise FileNotFoundError

        limit = 10_000
        entries: list[dict[str, object]] = []
        truncated = False
        archive_format = ""
        try:
            if zipfile.is_zipfile(path):
                archive_format = "ZIP"
                with zipfile.ZipFile(path, "r") as archive:
                    for index, info in enumerate(archive.infolist()):
                        if index >= limit:
                            truncated = True
                            break
                        name = self.archive_name(info.filename)
                        if not name:
                            continue
                        try:
                            modified = datetime(*info.date_time, tzinfo=timezone.utc).isoformat()
                        except (TypeError, ValueError):
                            modified = None
                        entries.append({
                            "path": name,
                            "kind": "directory" if info.is_dir() else "file",
                            "size": 0 if info.is_dir() else info.file_size,
                            "compressedSize": 0 if info.is_dir() else info.compress_size,
                            "modified": modified,
                            "encrypted": bool(info.flag_bits & 0x1),
                        })
            else:
                archive_format = "TAR"
                with tarfile.open(path, "r:*") as archive:
                    for index, member in enumerate(archive):
                        if index >= limit:
                            truncated = True
                            break
                        name = self.archive_name(member.name)
                        if not name:
                            continue
                        kind = "directory" if member.isdir() else "link" if member.issym() or member.islnk() else "file"
                        entries.append({
                            "path": name,
                            "kind": kind,
                            "size": 0 if member.isdir() else member.size,
                            "compressedSize": None,
                            "modified": datetime.fromtimestamp(member.mtime, tz=timezone.utc).isoformat() if member.mtime else None,
                            "linkTarget": member.linkname if kind == "link" else None,
                        })
        except (zipfile.BadZipFile, tarfile.TarError, OSError, EOFError) as exc:
            self.send_error_json(HTTPStatus.BAD_REQUEST, f"压缩包读取失败：{exc}")
            return

        file_count = sum(item["kind"] != "directory" for item in entries)
        directory_names: set[str] = set()
        for item in entries:
            parts = str(item["path"]).split("/")
            stop = len(parts) if item["kind"] == "directory" else len(parts) - 1
            directory_names.update("/".join(parts[:index]) for index in range(1, stop + 1))
        directory_count = len(directory_names)
        self.send_json({
            "path": raw_path,
            "format": archive_format,
            "entries": entries,
            "fileCount": file_count,
            "directoryCount": directory_count,
            "truncated": truncated,
            "limit": limit,
        })

    def stream_file(self, raw_path: str, inline: bool) -> None:
        path = self.safe_path(raw_path)
        if not path.is_file():
            raise FileNotFoundError

        size = path.stat().st_size
        mime = human_type(path)
        start, end = 0, max(0, size - 1)
        status = HTTPStatus.OK
        range_header = self.headers.get("Range")

        if range_header:
            match = RANGE_RE.fullmatch(range_header.strip())
            if not match:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            first, last = match.groups()
            if first:
                start = int(first)
                end = min(int(last), size - 1) if last else size - 1
            elif last:
                start = max(0, size - int(last))
            if start >= size or end < start:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            status = HTTPStatus.PARTIAL_CONTENT

        length = max(0, end - start + 1)
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Last-Modified", formatdate(path.stat().st_mtime, usegmt=True))
        disposition = "inline" if inline else "attachment"
        self.send_header(
            "Content-Disposition",
            f"{disposition}; filename*=UTF-8''{quote(path.name)}",
        )
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()

        with path.open("rb") as file:
            file.seek(start)
            remaining = length
            while remaining:
                chunk = file.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
                remaining -= len(chunk)

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description="浏览并预览服务器文件")
    parser.add_argument("--root", default=os.getcwd(), help="允许浏览的根目录")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址")
    parser.add_argument("--port", default=8989, type=int, help="监听端口")
    parser.add_argument("--show-hidden", action="store_true", help="显示隐藏文件")
    args = parser.parse_args()

    root = Path(args.root).expanduser().resolve()
    if not root.is_dir():
        parser.error(f"目录不存在: {root}")

    server = ThreadingHTTPServer((args.host, args.port), FileViewerHandler)
    server.files_root = root  # type: ignore[attr-defined]
    server.show_hidden = args.show_hidden  # type: ignore[attr-defined]
    print(f"File Viewer: http://{args.host}:{args.port}")
    print(f"Shared root: {root}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
