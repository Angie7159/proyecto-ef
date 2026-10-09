"""Prueba manual visible de ingreso a una reunión de Teams."""

import sys
import time
import traceback

from playwright.sync_api import sync_playwright


def main() -> None:
    if len(sys.argv) < 2:
        print("Uso: python test_bot_manual.py <URL_DE_REUNION_TEAMS>")
        raise SystemExit(1)

    browser = None
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                headless=False,
                args=[
                    "--use-fake-ui-for-media-stream",
                    "--use-fake-device-for-media-stream",
                    "--disable-blink-features=AutomationControlled",
                ],
            )
            context = browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                )
            )
            page = context.new_page()
            page.goto(sys.argv[1], wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(5000)

            for selector in (
                'input[placeholder*="nombre" i]',
                'input[aria-label*="nombre" i]',
                'input[type="text"]',
            ):
                try:
                    field = page.locator(selector).first
                    if field.is_visible(timeout=1500):
                        field.fill("MeetIA Bot")
                        break
                except Exception:
                    continue

            for selector in (
                'button:has-text("Unirse ahora")',
                'button:has-text("Join now")',
                'button:has-text("Join")',
                'button[data-tid="prejoin-join-button"]',
            ):
                try:
                    button = page.locator(selector).first
                    if button.is_visible(timeout=1500):
                        button.click(timeout=3000)
                        break
                except Exception:
                    continue

            page.wait_for_timeout(10000)
            page.screenshot(path="./bot_test_screenshot.png", full_page=True)
            with open("./bot_test_page.html", "w", encoding="utf-8") as html_file:
                html_file.write(page.content())

            body = page.locator("body").inner_text(timeout=5000).casefold()
            has_leave = any(
                page.get_by_role("button", name=name, exact=False).count() > 0
                for name in ("Salir", "Leave")
            )
            if "/l/meetup-join" in page.url and has_leave:
                print("✅ Bot unido a la reunión")
            elif any(word in body for word in ("espera", "lobby", "waiting")):
                print("⚠️ Bot en sala de espera")
            else:
                print("❌ Estado desconocido")

            time.sleep(30)
            context.close()
            browser.close()
            browser = None
    except Exception:
        traceback.print_exc()
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception:
                traceback.print_exc()


if __name__ == "__main__":
    main()
