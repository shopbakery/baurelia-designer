"""Offline tests for WebP variants; no R2 credentials or network required."""

from __future__ import annotations

import tempfile
import unittest
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw

from r2_variants import Config, make_variants, run, variant_keys
from test_r2_resize import FakeClient, png


TEST_DIR = Path(__file__).resolve().parent


def config() -> Config:
    return Config("account", "access", "secret", "bucket", "https://media.example", 1024 * 1024)


class VariantTests(unittest.TestCase):
    def test_keys_keep_category_and_original_extension(self):
        keys = variant_keys("motifs-v2/zahnfee/Zahnfee 9.png")
        self.assertEqual(keys["thumbnail"], "motifs-v2-thumbs/zahnfee/Zahnfee 9.png.webp")
        self.assertEqual(keys["preview"], "motifs-v2-previews/zahnfee/Zahnfee 9.png.webp")
        self.assertNotEqual(
            keys["thumbnail"],
            variant_keys("motifs-v2/zahnfee/Zahnfee 9.jpg")["thumbnail"],
        )
        with self.assertRaises(ValueError):
            variant_keys("Zahnfee/Zahnfee 9.png")

    def test_variants_keep_transparency_aspect_ratio_and_no_padding(self):
        image = Image.new("RGBA", (1200, 600), (0, 0, 0, 0))
        ImageDraw.Draw(image).rectangle((300, 150, 900, 450), fill=(255, 0, 0, 255))
        buffer = BytesIO()
        image.save(buffer, format="PNG")
        source = buffer.getvalue()
        variants, details = make_variants(source, ("thumbnail", "preview"))
        self.assertEqual(details["source_dimensions"], [1200, 600])
        for name, expected in (("thumbnail", (300, 150)), ("preview", (900, 450))):
            with Image.open(BytesIO(variants[name]["data"])) as image:
                image.load()
                self.assertEqual(image.format, "WEBP")
                self.assertEqual(image.size, expected)
                self.assertEqual(image.convert("RGBA").getpixel((0, 0))[3], 0)
                self.assertEqual(image.convert("RGBA").getpixel((expected[0] // 2, expected[1] // 2))[3], 255)

    def test_palette_transparency_is_preserved_without_upscaling(self):
        image = Image.new("P", (80, 40), 0)
        image.putpalette([0, 0, 0, 255, 0, 0] + [0] * 762)
        image.info["transparency"] = 0
        image.putpixel((40, 20), 1)
        buffer = BytesIO()
        image.save(buffer, format="PNG")
        variants, _ = make_variants(buffer.getvalue(), ("thumbnail", "preview"))
        for variant in variants.values():
            with Image.open(BytesIO(variant["data"])) as result:
                self.assertEqual(result.size, (80, 40))
                self.assertEqual(result.convert("RGBA").getpixel((0, 0))[3], 0)
                self.assertEqual(result.convert("RGBA").getpixel((40, 20))[3], 255)

    def test_dry_run_apply_and_resume_without_overwrite(self):
        source_key = "motifs-v2/zahnfee/Zahnfee 9.png"
        source = png((400, 400))
        client = FakeClient({source_key: source})
        with tempfile.TemporaryDirectory(dir=TEST_DIR) as temp:
            report = Path(temp) / "report.jsonl"
            dry = run(client, config(), apply=False, category="zahnfee", limit=None, report_path=report)
            self.assertEqual((dry["planned"], client.put_count), (2, 0))
            report.unlink()

            applied = run(client, config(), apply=True, category="zahnfee", limit=None, report_path=report)
            self.assertEqual((applied["created"], client.put_count), (2, 2))
            self.assertEqual(client.objects[source_key], source)
            keys = variant_keys(source_key)
            self.assertEqual(client.types[keys["thumbnail"]], "image/webp")
            self.assertEqual(client.types[keys["preview"]], "image/webp")
            report.unlink()

            again = run(client, config(), apply=True, category="zahnfee", limit=None, report_path=report)
            self.assertEqual((again["exists"], client.put_count), (2, 2))
            report.unlink()

            del client.objects[keys["preview"]]
            del client.types[keys["preview"]]
            resumed = run(client, config(), apply=True, category="zahnfee", limit=None, report_path=report)
            self.assertEqual((resumed["exists"], resumed["created"], client.put_count), (1, 1, 3))

    def test_category_scope_does_not_touch_other_masters(self):
        client = FakeClient({
            "motifs-v2/zahnfee/one.png": png((100, 100)),
            "motifs-v2/affe/two.png": png((100, 100)),
        })
        with tempfile.TemporaryDirectory(dir=TEST_DIR) as temp:
            result = run(
                client, config(), apply=True, category="zahnfee", limit=None,
                report_path=Path(temp) / "report.jsonl",
            )
        self.assertEqual((result["created"], client.put_count), (2, 2))
        self.assertFalse(any("/affe/" in key for key in client.types))

    def test_bad_existing_target_is_reported_and_not_overwritten(self):
        source_key = "motifs-v2/zahnfee/one.png"
        target = variant_keys(source_key)["thumbnail"]
        client = FakeClient({source_key: png((100, 100)), target: b"bad"})
        client.types[target] = "text/plain"
        with tempfile.TemporaryDirectory(dir=TEST_DIR) as temp:
            result = run(
                client, config(), apply=True, category="zahnfee", limit=None,
                report_path=Path(temp) / "report.jsonl",
            )
        self.assertEqual((result["failed"], client.put_count), (1, 0))
        self.assertEqual(client.objects[target], b"bad")


if __name__ == "__main__":
    unittest.main()
