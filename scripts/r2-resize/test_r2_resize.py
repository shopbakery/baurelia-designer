"""Offline tests; no R2 credentials or network required."""

from __future__ import annotations

import tempfile
import unittest
from io import BytesIO
from pathlib import Path

from PIL import Image

from r2_resize import Config, destination_key, make_output, run


TEST_DIR = Path(__file__).resolve().parent


def png(size: tuple[int, int]) -> bytes:
    image = Image.new("RGBA", size, (0, 0, 0, 0))
    image.putpixel((size[0] // 2, size[1] // 2), (255, 0, 0, 255))
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def config() -> Config:
    return Config("account", "access", "secret", "bucket", "https://media.example", "", "motifs-v2/", 200, 1024 * 1024)


class FakeBody:
    def __init__(self, data: bytes):
        self.stream = BytesIO(data)

    def read(self, size: int = -1) -> bytes:
        return self.stream.read(size)

    def close(self) -> None:
        self.stream.close()


class FakePaginator:
    def __init__(self, objects: dict[str, bytes]):
        self.objects = objects

    def paginate(self, *, Bucket: str, Prefix: str):
        yield {
            "Contents": [
                {"Key": key, "Size": len(data), "ETag": '"test"'}
                for key, data in self.objects.items() if key.startswith(Prefix)
            ]
        }


class FakeClient:
    def __init__(self, objects: dict[str, bytes]):
        self.objects = objects.copy()
        self.types = {}
        self.put_count = 0

    def get_paginator(self, name: str):
        assert name == "list_objects_v2"
        return FakePaginator(self.objects)

    def get_object(self, *, Bucket: str, Key: str, IfMatch: str, Range: str | None = None):
        data = self.objects[Key]
        if Range:
            end = int(Range.split("-")[1])
            data = data[: end + 1]
        return {"Body": FakeBody(data)}

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, ContentType: str, CacheControl: str, IfNoneMatch: str):
        assert IfNoneMatch == "*" and Key not in self.objects
        self.objects[Key] = Body
        self.types[Key] = ContentType
        self.put_count += 1
        return {"ETag": '"new"'}

    def head_object(self, *, Bucket: str, Key: str):
        return {"ContentLength": len(self.objects[Key]), "ContentType": self.types[Key]}


class ResizeTests(unittest.TestCase):
    def test_category_mapping(self):
        cfg = config()
        self.assertEqual(destination_key(cfg, "Zahnfee/Zahnfee 9.png"), "motifs-v2/zahnfee/Zahnfee 9.png")
        self.assertEqual(destination_key(cfg, "motifs/affe/uuid.png"), "motifs-v2/affe/uuid.png")

    def test_resize_keeps_alpha_and_small_file_is_identical(self):
        large = png((400, 398))
        output, before, after, alpha_before, alpha_after, action = make_output(large, "PNG", 200)
        self.assertEqual((before, after, action), ((400, 398), (200, 199), "resized"))
        self.assertEqual(alpha_before, (0, 255))
        self.assertIsNotNone(alpha_after)
        self.assertEqual(alpha_after[0], 0)
        small = png((100, 100))
        self.assertEqual(make_output(small, "PNG", 200)[0], small)

    def test_dry_run_then_apply_never_overwrites(self):
        client = FakeClient({"Zahnfee/Large.png": png((400, 400)), "motifs/affe/Small.png": png((100, 100))})
        with tempfile.TemporaryDirectory(dir=TEST_DIR) as temp:
            path = Path(temp) / "report.jsonl"
            dry = run(client, config(), apply=False, limit=None, report_path=path)
            self.assertEqual((dry["planned_resize"], dry["planned_copy"], client.put_count), (1, 1, 0))
            applied = run(client, config(), apply=True, limit=None, report_path=path)
            self.assertEqual((applied["resized"], applied["copied"], client.put_count), (1, 1, 2))
            again = run(client, config(), apply=True, limit=None, report_path=path)
            self.assertEqual((again["exists"], client.put_count), (2, 2))

    def test_collision_stops_before_upload(self):
        client = FakeClient({"Zahnfee/A.png": png((10, 10)), "motifs/zahnfee/A.png": png((10, 10))})
        with tempfile.TemporaryDirectory(dir=TEST_DIR) as temp:
            with self.assertRaisesRegex(ValueError, "Kollision"):
                run(client, config(), apply=True, limit=None, report_path=Path(temp) / "report.jsonl")
        self.assertEqual(client.put_count, 0)

    def test_wrong_extension_uses_actual_image_mime(self):
        client = FakeClient({"Einhorn/Einhorn 43.jpg": png((100, 100))})
        with tempfile.TemporaryDirectory(dir=TEST_DIR) as temp:
            path = Path(temp) / "report.jsonl"
            result = run(client, config(), apply=True, limit=None, report_path=path)
            self.assertEqual(result["copied"], 1)
            self.assertEqual(client.types["motifs-v2/einhorn/Einhorn 43.jpg"], "image/png")


if __name__ == "__main__":
    unittest.main()
