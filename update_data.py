"""Fetches Entur's national GTFS feed and writes the files server.py reads into data/.

    python3 update_data.py            # downloads the feed from Entur (about 95 MB)
    python3 update_data.py feed.zip   # uses a feed already on disk

Restart the server afterwards. Entur publishes a new feed every night, so once a day is the most
that makes sense. The old files stay in place until the new ones are complete.
"""

import csv
import io
import os
import sys
import tempfile
import urllib.request
import zipfile
from collections.abc import Iterator
from pathlib import Path

FEED_URL = "https://storage.googleapis.com/marduk-production/outbound/gtfs/rb_norway-aggregated-gtfs-basic.zip"
DATA_DIR = Path(__file__).resolve().parent / "data"
COPIED = ("stops.txt", "routes.txt", "agency.txt")


def rows(feed: zipfile.ZipFile, name: str) -> Iterator[dict[str, str]]:
    with feed.open(name) as raw:
        yield from csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))


def stop_routes(feed: zipfile.ZipFile) -> list[tuple[str, str]]:
    """(stop, route) pairs for every line that stops there, with platforms counted as their station."""
    stations = {row["stop_id"]: row.get("parent_station") or row["stop_id"] for row in rows(feed, "stops.txt")}
    trip_routes = {row["trip_id"]: row["route_id"] for row in rows(feed, "trips.txt")}
    pairs = set()
    for row in rows(feed, "stop_times.txt"):
        if row.get("pickup_type") == row.get("drop_off_type") == "1":
            continue  # The trip passes this stop without stopping.
        route = trip_routes.get(row["trip_id"])
        if route:
            pairs.add((stations.get(row["stop_id"], row["stop_id"]), route))
    return sorted(pairs)


def main() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=DATA_DIR) as temp_name:
        temp = Path(temp_name)
        feed_path = Path(sys.argv[1]) if len(sys.argv) > 1 else temp / "gtfs.zip"
        if len(sys.argv) == 1:
            print(f"Downloading {FEED_URL}")
            urllib.request.urlretrieve(FEED_URL, feed_path)
        with zipfile.ZipFile(feed_path) as feed:
            for name in COPIED:
                (temp / name).write_bytes(feed.read(name))
            pairs = stop_routes(feed)
        with (temp / "stop_routes.txt").open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(["stop_id", "route_id"])
            writer.writerows(pairs)
        for name in (*COPIED, "stop_routes.txt"):
            os.replace(temp / name, DATA_DIR / name)
    print(f"Wrote {', '.join(COPIED)} and {len(pairs)} stop/route pairs to {DATA_DIR}")


if __name__ == "__main__":
    main()
