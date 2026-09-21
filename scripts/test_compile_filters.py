import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compile_filters as filters


class NetworkTests(unittest.TestCase):
    def parse(self, line: str):
        return filters.parse_network_line(line, filters.Stats())

    def test_pure_domain_blocks_subresources_only(self):
        parsed = self.parse("||doubleclick.net^")
        self.assertTrue(parsed["network"])
        self.assertEqual(parsed["host"], "doubleclick.net")
        self.assertFalse(parsed["allow"])
        self.assertEqual(parsed["types"], {"excludedResourceTypes": ["main_frame"]})
        self.assertEqual(parsed["priority"], filters.PRIORITY_BLOCK)

    def test_third_party_and_script_type(self):
        parsed = self.parse("||tracker.example^$script,third-party")
        self.assertEqual(parsed["host"], "tracker.example")
        self.assertEqual(parsed["party"], "thirdParty")
        self.assertEqual(parsed["types"], {"resourceTypes": ["script"]})

    def test_exception_outranks_block(self):
        parsed = self.parse("@@||good.example^$script,domain=news.example")
        self.assertTrue(parsed["allow"])
        self.assertEqual(parsed["priority"], filters.PRIORITY_ALLOW)
        self.assertEqual(parsed["initiators"], ["news.example"])
        self.assertEqual(parsed["types"], {"resourceTypes": ["script"]})

    def test_generichide_is_not_a_network_allow(self):
        parsed = self.parse("@@||news.example^$generichide")
        self.assertFalse(parsed["network"])
        self.assertTrue(parsed["generichide"])
        self.assertEqual(parsed["host"], "news.example")

    def test_unknown_option_is_skipped(self):
        self.assertIsNone(self.parse("||ads.example^$csp=script-src 'none'"))

    def test_dollar_in_path_keeps_real_options(self):
        parsed = self.parse("||cdn.example/ads/$file.js$script")
        self.assertEqual(parsed["pattern"], "||cdn.example/ads/$file.js")
        self.assertEqual(parsed["types"], {"resourceTypes": ["script"]})

    def test_ping_catchall_stays_narrow(self):
        parsed = self.parse("*$ping,third-party")
        self.assertTrue(parsed["network"])
        self.assertTrue(parsed["catchall"])
        self.assertEqual(parsed["types"], {"resourceTypes": ["ping"]})
        self.assertEqual(parsed["party"], "thirdParty")

    def test_typeless_catchall_is_not_emitted(self):
        parsed = self.parse("*$third-party")
        self.assertFalse(parsed["network"])

    def test_document_option_includes_the_main_frame(self):
        parsed = self.parse("||pop.example^$document")
        self.assertEqual(parsed["types"], {"resourceTypes": ["main_frame"]})

    def test_negated_script_excludes_documents_too(self):
        parsed = self.parse("||pixel.example/track^$~script")
        self.assertCountEqual(
            parsed["types"]["excludedResourceTypes"],
            ["script", "main_frame"],
        )


class CompileTests(unittest.TestCase):
    def test_domains_are_batched(self):
        text = "\n".join(f"||ad{index}.example^" for index in range(3))
        path = Path(self.id() + ".txt")
        try:
            path.write_text(text, encoding="utf-8")
            rules, generichide = filters.compile_network([path], filters.Stats())
        finally:
            path.unlink(missing_ok=True)
        self.assertEqual(generichide, [])
        self.assertEqual(len(rules), 1)
        self.assertEqual(
            rules[0]["condition"]["requestDomains"],
            ["ad0.example", "ad1.example", "ad2.example"],
        )
        self.assertEqual(rules[0]["action"], {"type": "block"})

    def test_cosmetic_exceptions_leave_the_global_stylesheet(self):
        text = "\n".join(
            [
                "##.banner-ad",
                "##.kept",
                "news.example#@#.banner-ad",
                "news.example##.site-ad",
                "news.example##:-abp-has(.ad)",
            ]
        )
        path = Path(self.id() + "-cosmetic.txt")
        try:
            path.write_text(text, encoding="utf-8")
            css, sites = filters.compile_cosmetic([path], ["broken.example"], filters.Stats())
        finally:
            path.unlink(missing_ok=True)
        self.assertIn(".kept", css)
        self.assertNotIn(".banner-ad", css)
        self.assertEqual(sites["conditional"], [".banner-ad"])
        self.assertEqual(sites["except"], {"news.example": [".banner-ad"]})
        self.assertEqual(sites["extra"], {"news.example": [".site-ad"]})
        self.assertEqual(sites["generichide"], ["broken.example"])
        self.assertIn('html:not([data-adronin="off"]):not([data-adronin-generic="off"]) .kept', css)


if __name__ == "__main__":
    unittest.main()
