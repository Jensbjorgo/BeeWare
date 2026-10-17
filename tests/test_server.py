import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class FreshCheckoutTests(unittest.TestCase):
    def test_startup_without_local_data_and_auth_lifecycle(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            shutil.copy(ROOT / "server.py", target / "server.py")
            result = subprocess.run(
                [sys.executable, "-c", """
import server
assert server.transit_data.search_stops('sentrum') == []
assert server.transit_data.search_routes('') == []
assert server.transit_data.find_nearby_stops(58.15, 8.0) == []
assert server.sighting_store.list_recent() == []
auth = server.auth_store
auth.create_user('tester', 'test-password')
assert auth.authenticate('tester', 'wrong') is None
assert auth.authenticate('tester', 'test-password') == {'username': 'tester'}
token = auth.create_session('tester')
assert auth.get_session_user(token) == {'username': 'tester'}
auth.delete_session(token)
assert auth.get_session_user(token) is None
"""],
                cwd=target, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads((target / "storage/sessions.json").read_text()), {})

    def test_gtfs_search_and_nearest_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            shutil.copy(ROOT / "server.py", target / "server.py")
            (target / "data").mkdir()
            (target / "data/stops.txt").write_text(
                "stop_id,stop_name,stop_lat,stop_lon\n1,Sentrum,58.15,8.0\n",
                encoding="utf-8",
            )
            (target / "data/routes.txt").write_text(
                "route_id,route_short_name,route_long_name\n1,10,Sentrum\n",
                encoding="utf-8",
            )
            result = subprocess.run(
                [sys.executable, "-c", """
import server
data = server.transit_data
assert data.search_stops('sent')[0]['id'] == '1'
assert data.search_routes('10')[0]['long_name'] == 'Sentrum'
assert data.find_nearby_stops(58.15, 8.0)[0]['distance_m'] == 0
"""],
                cwd=target, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
