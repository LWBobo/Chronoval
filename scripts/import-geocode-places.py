#!/usr/bin/env python3
"""将 data/map_info/geocode_places_*.csv 导入 SQLite geocode_places 表。"""

from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "data" / "app.sqlite3"
DEFAULT_CSV = ROOT / "data" / "map_info" / "geocode_places_90000.csv"

CREATE_SQL = """
CREATE TABLE IF NOT EXISTS geocode_places (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  name TEXT NOT NULL,
  name_en TEXT,
  aliases TEXT,
  pinyin TEXT,
  pinyin_abbr TEXT,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  country TEXT,
  province TEXT,
  city TEXT,
  district TEXT,
  place_type TEXT,
  admin_code TEXT,
  priority INTEGER DEFAULT 0 NOT NULL,
  enabled INTEGER DEFAULT 1 NOT NULL,
  source TEXT,
  notes TEXT,
  created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
);
"""

INDEX_SQL = [
    "CREATE INDEX IF NOT EXISTS idx_geocode_places_enabled_priority ON geocode_places (enabled, priority);",
    "CREATE INDEX IF NOT EXISTS idx_geocode_places_name ON geocode_places (name);",
    "CREATE INDEX IF NOT EXISTS idx_geocode_places_city ON geocode_places (city);",
    "CREATE INDEX IF NOT EXISTS idx_geocode_places_province ON geocode_places (province);",
    "CREATE INDEX IF NOT EXISTS idx_geocode_places_district ON geocode_places (district);",
    "CREATE INDEX IF NOT EXISTS idx_geocode_places_place_type ON geocode_places (place_type);",
]

INSERT_SQL = """
INSERT INTO geocode_places (
  name, name_en, aliases, pinyin, pinyin_abbr,
  latitude, longitude, country, province, city, district,
  place_type, admin_code, priority, enabled, source, notes,
  created_at, updated_at
) VALUES (
  ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?
)
"""


def empty_to_none(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    return text if text else None


def parse_bool(value: str | None, default: int = 1) -> int:
    if value is None or str(value).strip() == "":
        return default
    return 1 if str(value).strip() in {"1", "true", "True", "yes", "YES"} else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Import geocode_places CSV")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument(
        "--replace",
        action="store_true",
        help="清空现有 geocode_places 后再导入（默认开启）",
        default=True,
    )
    parser.add_argument(
        "--no-replace",
        action="store_true",
        help="追加导入，不清空表",
    )
    args = parser.parse_args()
    replace = not args.no_replace

    if not args.csv.is_file():
        print(f"CSV not found: {args.csv}", file=sys.stderr)
        return 1
    args.db.parent.mkdir(parents=True, exist_ok=True)

    now = int(time.time())
    conn = sqlite3.connect(args.db)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute(CREATE_SQL)
        for stmt in INDEX_SQL:
            conn.execute(stmt)

        if replace:
            conn.execute("DELETE FROM geocode_places")
            # 重置自增，便于重复导入
            conn.execute(
                "DELETE FROM sqlite_sequence WHERE name = 'geocode_places'"
            )

        batch: list[tuple] = []
        total = 0
        skipped = 0
        with args.csv.open("r", encoding="utf-8-sig", newline="") as fh:
            reader = csv.DictReader(fh)
            required = {"name", "latitude", "longitude"}
            if not reader.fieldnames or not required.issubset(set(reader.fieldnames)):
                print(
                    f"CSV missing required columns {required}, got {reader.fieldnames}",
                    file=sys.stderr,
                )
                return 1

            for row in reader:
                name = empty_to_none(row.get("name"))
                if not name:
                    skipped += 1
                    continue
                try:
                    lat = float(row["latitude"])
                    lon = float(row["longitude"])
                except (KeyError, TypeError, ValueError):
                    skipped += 1
                    continue
                if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                    skipped += 1
                    continue

                priority_raw = empty_to_none(row.get("priority"))
                try:
                    priority = int(float(priority_raw)) if priority_raw else 0
                except ValueError:
                    priority = 0

                batch.append(
                    (
                        name,
                        empty_to_none(row.get("name_en")),
                        empty_to_none(row.get("aliases")),
                        empty_to_none(row.get("pinyin")),
                        empty_to_none(row.get("pinyin_abbr")),
                        lat,
                        lon,
                        empty_to_none(row.get("country")),
                        empty_to_none(row.get("province")),
                        empty_to_none(row.get("city")),
                        empty_to_none(row.get("district")),
                        empty_to_none(row.get("place_type")),
                        empty_to_none(row.get("admin_code")),
                        priority,
                        parse_bool(row.get("enabled"), 1),
                        empty_to_none(row.get("source")),
                        empty_to_none(row.get("notes")),
                        now,
                        now,
                    )
                )
                if len(batch) >= 1000:
                    conn.executemany(INSERT_SQL, batch)
                    total += len(batch)
                    batch.clear()
                    if total % 10000 == 0:
                        print(f"imported {total}...")

            if batch:
                conn.executemany(INSERT_SQL, batch)
                total += len(batch)

        conn.commit()
        count = conn.execute("SELECT COUNT(*) FROM geocode_places").fetchone()[0]
        print(f"Done. inserted={total} skipped={skipped} table_count={count} db={args.db}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
