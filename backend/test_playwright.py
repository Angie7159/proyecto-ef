"""Smoke test manual de Playwright. Ejecutar con: python test_playwright.py"""

from playwright.sync_api import sync_playwright


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.goto("https://www.google.com", wait_until="domcontentloaded")
            print(page.title())
        finally:
            browser.close()


if __name__ == "__main__":
    main()
