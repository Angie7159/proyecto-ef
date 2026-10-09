"""Automatización visible/aislada de reuniones Teams mediante Playwright."""

import threading
import time
import traceback
import json
from datetime import datetime
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, unquote, urlencode, urlparse

import truststore

truststore.inject_into_ssl()

from playwright.sync_api import Browser, BrowserContext, Page, Playwright, sync_playwright


BASE_DIR = Path(__file__).resolve().parents[2]
PROFILE_DIR = BASE_DIR / "bot_profile_teams"
STORAGE_STATE_FILE = PROFILE_DIR / "storage_state.json"
SCREENSHOT_DIR = BASE_DIR / "bot_screenshots"
LOG_DIR = BASE_DIR / "bot_logs"
SELECTORES_SUBTITULOS = (
    '[data-tid="closed-caption-text"]',
    '[data-tid="closed-caption-v2"]',
    '.fui-ChatMessageCompact',
    '[aria-live="polite"][role="log"]',
    'div[role="log"]',
    '.ui-box:has-text("Live captions")',
    'span[class*="caption"]',
    'div[class*="captionText"]',
)
SELECTORES_INPUT_NOMBRE = (
    'input[placeholder*="Escribe tu nombre"]',
    'input[placeholder*="Enter your name"]',
    'input[placeholder*="Type your name"]',
    'input[aria-label*="nombre"]',
    'input[aria-label*="name"]',
    'input[data-tid="prejoin-display-name-input"]',
    'input[type="text"]',
)
SELECTORES_BOTON_UNIRSE = (
    'button:has-text("Unirse ahora")',
    'button:has-text("Join now")',
    'button[data-tid="prejoin-join-button"]',
    'button:has-text("Unirse a la reunión")',
    'button:has-text("Join meeting")',
)
SELECTORES_DENTRO_REUNION = (
    '[data-tid="hangup-button"]',
    '[data-tid="call-hangup-button"]',
    'button:has-text("Salir")',
    'button:has-text("Leave")',
    '[aria-label*="Colgar"]',
    '[aria-label*="Hang up"]',
)
SELECTORES_SALA_ESPERA = (
    'text="Esperando a que alguien te admita"',
    'text="Waiting for someone to admit"',
    '[data-tid="lobby-wait-screen"]',
)
_bots_activos: dict[str, "TeamsBot"] = {}
_bots_activos_lock = threading.Lock()
_TEAMS_PROFILE_LOCK = threading.Lock()


def _is_browser_closed_error(exc: BaseException) -> bool:
    message = str(exc).casefold()
    return any(phrase in message for phrase in (
        "has been closed", "target closed", "target page, context or browser has been closed",
        "browser has been closed", "page has been closed", "context has been closed",
    ))


def _log(message: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}", flush=True)


def transformar_url_launcher_a_directa(url: str) -> str:
    """Convierte una URL del Launcher de Teams en su destino web directo."""
    if "launcher" not in url.casefold():
        return url
    try:
        parsed = urlparse(url)
        params = parse_qs(parsed.query)
        encoded_destination = params.get("url", [None])[0]
        if not encoded_destination:
            _log("⚠️ URL es Launcher pero no tiene parámetro 'url'.")
            return url

        destination = unquote(encoded_destination)
        _log(f"🔍 URL decodificada: {destination[:120]}")
        if destination.startswith("/_#"):
            destination = destination.replace("/_#", "", 1)
        elif destination.startswith("/_"):
            destination = destination.replace("/_", "", 1)

        if destination.startswith("https://"):
            destination_parsed = urlparse(destination)
            hostname = (destination_parsed.hostname or "").casefold()
            if hostname != "teams.microsoft.com" and not hostname.endswith(".teams.microsoft.com"):
                raise ValueError("El parámetro url no apunta a teams.microsoft.com")
            final_url = destination
        else:
            if not destination.startswith("/"):
                destination = "/" + destination
            final_url = f"https://teams.microsoft.com{destination}"

        outer_params = {key: values for key, values in params.items() if key != "url"}
        if outer_params:
            separator = "&" if "?" in final_url else "?"
            final_url += separator + urlencode(outer_params, doseq=True)
        _log(f"🔀 URL transformada: {final_url[:120]}")
        return final_url
    except Exception as exc:
        _log(f"⚠️ Error transformando URL: {exc}")
        return url


class TeamsBot:
    def __init__(
        self,
        meeting_url: str,
        bot_name: str = "MeetIA Bot",
        headless: bool = True,
        timeout_seconds: int = 7200,
        reunion_id: str | None = None,
    ) -> None:
        self.meeting_url = meeting_url
        self.bot_name = bot_name
        self.headless = headless
        self.timeout_seconds = timeout_seconds
        self.reunion_id = reunion_id
        self.playwright: Playwright | None = None
        self.browser: Browser | None = None
        self.context: BrowserContext | None = None
        self.page: Page | None = None
        self._initial_pages_count = 0
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self._segments: list[dict] = []
        self._callback: Callable[[str], None] | None = None
        self._started_at: float | None = None
        self._last_caption = ""
        self._reconnected = False
        self._status = "failed"
        self._screenshot_path = ""
        self.status_callback: Callable[[str], None] | None = None
        self._last_reported_status = ""
        self._browser_closed = False
        self._stop_requested = False
        self._launcher_redirect_blocked = False
        self._profile_lock_acquired = False
        self._seen_captions: set[str] = set()
        self._diagnostic_index = 0
        self._last_diagnostic_at = 0.0
        self._last_screenshot_at = 0.0
        self._caption_activation_attempted = False
        self._final_snapshot_saved = False
        self._join_snapshot_index = 0
        self._next_join_snapshot_at = 0.0

    def detener(self) -> None:
        """Pide una parada cooperativa que respeta el hilo dueño de Playwright."""
        self._stop_requested = True
        self._stop_event.set()
        _log("🛑 Detención solicitada para el bot.")

    def _save_caption_log(self) -> None:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        filename = f"{self.reunion_id}_subtitulos.json" if self.reunion_id else "subtitulos.json"
        path = LOG_DIR / filename
        try:
            with self._lock:
                data = list(self._segments)
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as exc:
            _log(f"⚠️ No se pudo escribir el log de subtítulos: {exc}")

    def _diagnostic_event(self, message: str) -> None:
        line = f"[{datetime.now().strftime('%H:%M:%S')}] {message}"
        print(line, flush=True)
        if not self.reunion_id:
            return
        try:
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            with (LOG_DIR / f"{self.reunion_id}_events.log").open("a", encoding="utf-8") as log_file:
                log_file.write(line + "\n")
        except OSError:
            pass

    def _report_status(self, status: str) -> None:
        if self.status_callback and status != self._last_reported_status:
            self._last_reported_status = status
            try:
                self.status_callback(status)
            except Exception as exc:
                _log(f"⚠️ No se pudo reportar el estado {status}: {exc}")

    def _new_browser(self) -> None:
        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        _TEAMS_PROFILE_LOCK.acquire()
        self._profile_lock_acquired = True
        try:
            self.playwright = sync_playwright().start()
            context_options = dict(
                user_data_dir=str(PROFILE_DIR),
                headless=self.headless,
                args=[
                    "--use-fake-ui-for-media-stream",
                    "--use-fake-device-for-media-stream",
                    "--disable-blink-features=AutomationControlled",
                    "--disable-features=ExternalProtocolDialog,BlockInsecurePrivateNetworkRequests,ChromeWhatsNewUI",
                    "--no-default-browser-check",
                    "--disable-component-update",
                    "--disable-background-networking",
                ],
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                ),
                viewport={"width": 1280, "height": 800},
                ignore_https_errors=True,
            )
            self.context = self.playwright.chromium.launch_persistent_context(**context_options)
            if STORAGE_STATE_FILE.is_file():
                try:
                    with STORAGE_STATE_FILE.open("r", encoding="utf-8") as state_file:
                        state = json.load(state_file)
                    cookies = state.get("cookies", [])
                    if cookies:
                        self.context.add_cookies(cookies)
                        _log(f"🍪 Cookies cargadas desde storageState: {len(cookies)}")
                    else:
                        _log("⚠️ storageState sin cookies")
                except Exception as exc:
                    _log(f"⚠️ Error cargando storageState: {exc}")
            else:
                _log("⚠️ No hay storageState. Arrancando sin sesión.")
            active_cookies = self.context.cookies()
            _log(f"🍪 Total de cookies cargadas: {len(active_cookies)}")
            self._configure_context(self.context)
            self.page = self.context.pages[0] if self.context.pages else self.context.new_page()
            self._initial_pages_count = len(self.context.pages)
        except Exception:
            self._release_profile_lock()
            raise

    def _release_profile_lock(self) -> None:
        if self._profile_lock_acquired:
            self._profile_lock_acquired = False
            _TEAMS_PROFILE_LOCK.release()

    def _verificar_sesion(self) -> bool:
        cookies = self.context.cookies() if self.context else []
        _log(f"🍪 Total de cookies cargadas: {len(cookies)}")
        if len(cookies) < 10:
            _log(f"⚠️ Pocas cookies ({len(cookies)}). Continuando de todas formas...")
        return True

    def _configure_context(self, context: BrowserContext) -> None:
        def block_external_protocol(route) -> None:
            request_url = route.request.url.casefold()
            if request_url.startswith("msteams:") or "launchagent=join_launcher" in request_url:
                if request_url.startswith("msteams:"):
                    _log(f"🛑 Protocolo msteams bloqueado: {route.request.url[:120]}")
                else:
                    _log(f"🛡️ Lanzamiento de app bloqueado: {route.request.url[:120]}")
                route.abort()
            else:
                route.continue_()

        def block_launcher(route) -> None:
            request_url = route.request.url
            if (request_url.endswith("/launcher.html") or "/launcher/launcher.html" in request_url) and route.request.resource_type == "document":
                self._launcher_redirect_blocked = True
                _log("🛡️ Bloqueando página launcher")
                route.abort()
                return
            route.continue_()

        context.route("**/*", block_external_protocol)
        context.route("**/launcher.html**", block_launcher)
        _log("🛡️ Interceptor de Launcher activado.")
        context.on(
            "dialog",
            lambda dialog: (
                _log(f"⚠️ Diálogo JavaScript: {dialog.message}; se cierra automáticamente."),
                dialog.dismiss(),
            ),
        )

    @staticmethod
    def _click_first(page: Page, selectors: tuple[str, ...], timeout_ms: int = 1000) -> bool:
        for selector in selectors:
            try:
                candidate = page.locator(selector).first
                if candidate.is_visible(timeout=timeout_ms):
                    candidate.click(timeout=timeout_ms)
                    return True
            except Exception:
                continue
        return False

    def _save_diagnostic(self, page: Page) -> None:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        self._diagnostic_index += 1
        prefix = self.reunion_id or "teams_ui"
        path = LOG_DIR / f"{prefix}_page_{self._diagnostic_index}.html"
        try:
            path.write_text(page.content(), encoding="utf-8")
            _log(f"⚠️ Selectores no reconocidos; HTML guardado en {path}")
        except Exception as exc:
            _log(f"⚠️ No se pudo guardar HTML de diagnóstico: {exc}")

    def _save_join_screenshot(self, filename: str) -> None:
        if not self.page:
            return
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        path = LOG_DIR / f"{self.reunion_id or 'teams'}_{filename}"
        try:
            self.page.screenshot(path=str(path), full_page=True, timeout=10000)
            self._diagnostic_event(f"🖼️ Screenshot de ingreso guardado: {path.name}")
        except Exception as exc:
            if _is_browser_closed_error(exc):
                self._browser_closed = True
            self._diagnostic_event(f"⚠️ No se pudo guardar {path.name}: {exc}")

    def _maybe_save_join_interval(self) -> None:
        if self._next_join_snapshot_at and time.monotonic() >= self._next_join_snapshot_at:
            self._join_snapshot_index += 1
            self._save_join_screenshot(f"join_attempt_{self._join_snapshot_index}.png")
            self._next_join_snapshot_at = time.monotonic() + 15

    def _print_clickable_diagnostics(self, page: Page) -> None:
        _log("🔍 Buscando botones y links disponibles:")
        try:
            elements = page.query_selector_all('button, a[role="button"], [role="button"], a[href]')
            for element in elements[:50]:
                try:
                    text = (element.inner_text(timeout=1000) or "").strip()[:80].replace("\n", " ")
                    href = element.get_attribute("href") or ""
                    if text or href:
                        _log(f"   - '{text}' (href: {href[:60]})")
                except Exception:
                    continue
        except Exception as exc:
            _log(f"   ⚠️ No se pudieron enumerar elementos clicables: {exc}")
        try:
            _log(f"📄 Título: {page.title()}")
            _log(f"🌐 URL: {page.url}")
            self._save_diagnostic(page)
        except Exception as exc:
            if _is_browser_closed_error(exc):
                self._browser_closed = True
            _log(f"⚠️ No se pudo guardar el diagnóstico de Launcher: {exc}")

    def _classify_page(self, page: Page) -> str:
        url = page.url.casefold()
        if self._detect_join_state() == "joined":
            return "in_meeting"
        if "launcher" in url:
            return "launcher"
        if "launcher" not in url and ("/meet/" in url or "/l/meetup-join/" in url):
            return "prejoin"
        return "unknown"

    @staticmethod
    def _simulate_navigation_activity(page: Page) -> None:
        page.mouse.move(400, 300)
        page.wait_for_timeout(500)
        page.mouse.move(600, 400)
        page.wait_for_timeout(500)
        page.wait_for_timeout(2000)

    @staticmethod
    def _add_web_only_parameters(url: str) -> str:
        suffix = "launchAgent=join_only&directDl=false&suppressPrompt=true"
        return f"{url}{'&' if '?' in url else '?'}{suffix}"

    def _fill_prejoin_name(self, page: Page) -> bool:
        for selector in SELECTORES_INPUT_NOMBRE:
            try:
                field = page.locator(selector).first
                if field.is_visible(timeout=1200):
                    field.fill(self.bot_name, timeout=5000)
                    _log(f"✅ Nombre del bot escrito con selector: {selector}")
                    return True
            except Exception as exc:
                if _is_browser_closed_error(exc):
                    self._browser_closed = True
                    return False
        _log("⚠️ No se encontró el campo de nombre en pre-join.")
        self._print_clickable_diagnostics(page)
        return False

    def _try_click_join_button(self, page: Page) -> bool:
        self._save_join_screenshot("before_join.png")
        self._join_snapshot_index += 1
        self._save_join_screenshot(f"join_attempt_{self._join_snapshot_index}.png")
        for selector in SELECTORES_BOTON_UNIRSE:
            if self._stop_requested or self._browser_closed:
                return False
            try:
                element = page.wait_for_selector(selector, timeout=5000)
                self._maybe_save_join_interval()
                if element and element.is_visible():
                    element.click(force=True, timeout=5000)
                    _log(f"✅ Clic en botón: {selector}")
                    self._save_join_screenshot("after_join.png")
                    self._join_snapshot_index += 1
                    self._save_join_screenshot(f"join_attempt_{self._join_snapshot_index}.png")
                    return True
            except Exception as exc:
                self._maybe_save_join_interval()
                if self._browser_closed or _is_browser_closed_error(exc):
                    self._browser_closed = True
                    return False
                continue

        _log("⚠️ No se encontró botón de unirse. Botones disponibles:")
        try:
            for button in page.query_selector_all('button, a[role="button"], [role="button"], a')[:40]:
                text = (button.inner_text(timeout=1000) or "").strip()[:80].replace("\n", " ")
                if text:
                    _log(f"   - {text}")
        except Exception as exc:
            if _is_browser_closed_error(exc):
                self._browser_closed = True
            _log(f"   ⚠️ No se pudieron enumerar los botones: {exc}")
        try:
            self._save_diagnostic(page)
        except Exception:
            pass
        self._join_snapshot_index += 1
        self._save_join_screenshot(f"join_attempt_{self._join_snapshot_index}.png")
        return False

    def _detect_join_state(self) -> str | None:
        if not self.page:
            return None
        try:
            for selector in SELECTORES_DENTRO_REUNION:
                element = self.page.query_selector(selector)
                if element and element.is_visible():
                    return "joined"
            for selector in SELECTORES_SALA_ESPERA:
                element = self.page.query_selector(selector)
                if element and element.is_visible():
                    return "waiting_room"
            body = self._body_text()
            if "esperando a que alguien te admita" in body or "waiting for someone to admit" in body:
                return "waiting_room"
        except Exception as exc:
            if _is_browser_closed_error(exc):
                self._browser_closed = True
            else:
                _log(f"⚠️ Error verificando ingreso a Teams: {exc}")
        return None

    def _wait_for_join_state(self, timeout_seconds: int, minimum_wait_seconds: int = 0) -> str | None:
        started = time.monotonic()
        deadline = started + timeout_seconds
        if not self._next_join_snapshot_at:
            self._next_join_snapshot_at = started + 15
        while time.monotonic() < deadline and not self._stop_requested and not self._browser_closed:
            elapsed = time.monotonic() - started
            if elapsed >= minimum_wait_seconds:
                state = self._detect_join_state()
                if state:
                    return state
            self._maybe_save_join_interval()
            try:
                if self.page:
                    self.page.wait_for_timeout(3000)
                else:
                    break
            except Exception as exc:
                if _is_browser_closed_error(exc):
                    self._browser_closed = True
                    self._diagnostic_event("⚠️ Navegador cerrado mientras se esperaba el ingreso a la reunión.")
                    break
                raise
        return None

    def join(self) -> dict:
        try:
            if "teams.microsoft.com" not in urlparse(self.meeting_url).netloc.casefold():
                return {"success": False, "status": "failed", "message": "La URL no pertenece a Teams.", "screenshot_path": ""}
            url_final = transformar_url_launcher_a_directa(self.meeting_url)
            _log(f"📥 URL recibida: {self.meeting_url}")
            _log(f"📤 URL a navegar: {url_final}")
            if "launcher" in url_final.casefold():
                message = f"No se pudo evitar el Launcher. La URL transformada todavía contiene 'launcher': {url_final[:160]}"
                _log(f"❌ {message}")
                return {"success": False, "status": "failed", "message": message, "screenshot_path": ""}
            final_host = (urlparse(url_final).hostname or "").casefold()
            if final_host != "teams.microsoft.com" and not final_host.endswith(".teams.microsoft.com"):
                return {"success": False, "status": "failed", "message": "La URL transformada no pertenece a Teams.", "screenshot_path": ""}
            _log("🌐 Iniciando Chromium y navegando directo a Teams...")
            self._new_browser()
            assert self.page is not None and self.context is not None
            if not self._verificar_sesion():
                raise RuntimeError("Sesión Microsoft no válida: faltan cookies de Teams. Reconecta tu cuenta.")

            self._launcher_redirect_blocked = False
            self._save_join_screenshot("before_direct_navigation.png")
            _log(f"🌐 Navegando directo a: {url_final[:100]}")
            self._simulate_navigation_activity(self.page)
            try:
                self.page.goto(url_final, wait_until="domcontentloaded", timeout=60000)
                self.page.wait_for_timeout(8000)
                if "launcher" in self.page.url.casefold():
                    _log("❌ Aún en launcher. Diagnóstico:")
                    _log(f"   Cookies visibles: {len(self.context.cookies())}")
                    _log(f"   URL: {self.page.url}")
                    raise RuntimeError("Sesión no válida. Reconecta tu cuenta.")
            except Exception as nav_exc:
                if not self._launcher_redirect_blocked:
                    raise
                _log(f"⚠️ Redirect al Launcher abortado durante la navegación inicial: {nav_exc}")
            self._save_periodic_snapshot(self.page)
            _log(f"📄 URL actual: {self.page.url}")
            _log(f"📄 Título: {self.page.title()}")
            self._save_join_screenshot("after_direct_navigation.png")
            if self._browser_closed or self._stop_requested:
                return {"success": False, "status": "failed", "message": "El navegador se cerró antes de completar el ingreso.", "screenshot_path": ""}
            page_stage = self._classify_page(self.page)
            if self._launcher_redirect_blocked or "launcher" in self.page.url.casefold() or page_stage == "launcher":
                _log("⚠️ Redirigió a launcher. Reintentando una vez con la sesión cargada...")
                self.page.wait_for_timeout(5000)
                self._launcher_redirect_blocked = False
                try:
                    self.page.goto(url_final, wait_until="domcontentloaded", timeout=60000)
                    self.page.wait_for_timeout(8000)
                except Exception as retry_exc:
                    if not self._launcher_redirect_blocked:
                        raise retry_exc
                still_launcher = self._launcher_redirect_blocked or "launcher" in self.page.url.casefold()
                if still_launcher:
                    _log("❌ Aún en launcher tras 2 intentos.")
                    _log(f"   Cookies actuales: {len(self.context.cookies())}")
                    raise RuntimeError("No se pudo entrar a la reunión. La sesión podría haber expirado. Ve a Configuración y reconecta tu cuenta.")
                _log(f"✅ Fuera del launcher. URL: {self.page.url}")
                page_stage = self._classify_page(self.page)

            if "launcher" in self.page.url.casefold() or page_stage == "launcher":
                self._status = "failed"
                self._save_diagnostic(self.page)
                message = "No se pudo evitar el Launcher; la URL sigue conteniendo 'launcher' después de navegar directo."
                _log(f"❌ {message}")
                return {"success": False, "status": "failed", "message": message, "screenshot_path": self._screenshot_path}
            if page_stage == "in_meeting":
                self._status = "joined"
                self._report_status("joined")
                self._started_at = time.monotonic()
                _log("✅ Teams ya muestra los controles de llamada; bot dentro de la reunión.")
                return {"success": True, "status": "joined", "message": "Bot unido a la reunión.", "screenshot_path": self._screenshot_path}
            if self.page.locator('input[data-tid="prejoin-display-name-input"]').count() > 0:
                _log("✅ En pantalla pre-join (data-tid detectado).")
            elif self.page.locator('input[placeholder*="nombre" i], input[placeholder*="name" i]').count() > 0:
                _log("✅ En pantalla pre-join (input de nombre detectado).")
            elif self.page.locator('button:has-text("Salir"), button:has-text("Leave"), [data-tid="hangup-button"]').count() > 0:
                self._status = "joined"
                self._report_status("joined")
                self._started_at = time.monotonic()
                _log("✅ Ya estamos dentro de la reunión.")
                return {"success": True, "status": "joined", "message": "Bot unido a la reunión.", "screenshot_path": self._screenshot_path}
            else:
                _log("⚠️ Estado desconocido después de navegar directo.")
                self._save_join_screenshot("unknown_state.png")
                self._save_diagnostic(self.page)

            # Teams debe mostrar aquí el formulario de nombre y el botón de ingreso.
            _log("🧾 Buscando el formulario pre-join...")
            self.page.wait_for_timeout(5000)
            self._fill_prejoin_name(self.page)

            SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
            self._screenshot_path = str(SCREENSHOT_DIR / f"meeting_{int(time.time())}_join.png")
            self.page.screenshot(path=self._screenshot_path, full_page=True)

            join_state: str | None = None
            self._next_join_snapshot_at = time.monotonic() + 15
            for attempt in range(1, 4):
                if self._stop_requested or self._browser_closed:
                    break
                _log(f"🖱️ Intento {attempt}/3 para unirse desde la pantalla pre-join...")
                clicked = self._try_click_join_button(self.page)
                if clicked:
                    # Espera mínima de cinco segundos para que Teams navegue a la reunión.
                    join_state = self._wait_for_join_state(timeout_seconds=5, minimum_wait_seconds=5)
                    if join_state:
                        break
                if attempt < 3:
                    _log("🔁 El clic aún no confirmó el ingreso; se volverá a buscar el botón.")

            if not join_state and not self._stop_requested and not self._browser_closed:
                _log("⏳ Esperando hasta 60 segundos la confirmación de Teams...")
                join_state = self._wait_for_join_state(timeout_seconds=60)

            if join_state == "joined":
                self._status = "joined"
                self._report_status("joined")
                self._started_at = time.monotonic()
                _log("✅ Controles de llamada detectados; bot dentro de la reunión.")
                return {"success": True, "status": "joined", "message": "Bot unido a la reunión.", "screenshot_path": self._screenshot_path}
            if join_state == "waiting_room":
                self._report_status("waiting_room")
                _log("⏳ Teams confirmó que el bot está en la sala de espera.")
            elif not self._stop_requested and not self._browser_closed:
                self._diagnostic_event("⚠️ No se confirmaron controles de llamada ni sala de espera tras 60 segundos.")
                self._save_diagnostic(self.page)
                _log("⚠️ Se asume el ingreso a Teams después de esperar 60 segundos.")
                self._status = "joined"
                self._report_status("joined")
                self._started_at = time.monotonic()
                return {"success": True, "status": "joined", "message": "Ingreso asumido; la interfaz de Teams no confirmó el estado.", "screenshot_path": self._screenshot_path}

            deadline = time.monotonic() + 300
            while time.monotonic() < deadline:
                if self._stop_requested or self._browser_closed:
                    break
                if self._meeting_active():
                    self._status = "joined"
                    self._report_status("joined")
                    self._started_at = time.monotonic()
                    _log("✅ Bot unido a la reunión.")
                    return {"success": True, "status": "joined", "message": "Bot unido a la reunión.", "screenshot_path": self._screenshot_path}
                if self._is_waiting_room():
                    self._report_status("waiting_room")
                    _log("⏳ Bot en sala de espera; esperando admisión (máximo 5 min)...")
                    self._click_first(self.page, ('button:has-text("Admitir")', 'button:has-text("Admit")'))
                self.page.wait_for_timeout(3000)
            if self._is_waiting_room():
                self._status = "waiting_room_timeout"
                return {"success": False, "status": "waiting_room", "message": "El bot quedó en la sala de espera. Admítelo manualmente.", "screenshot_path": self._screenshot_path}
            self._status = "failed"
            return {"success": False, "status": "failed", "message": "No se pudo confirmar el ingreso a Teams.", "screenshot_path": self._screenshot_path}
        except Exception as exc:
            if _is_browser_closed_error(exc):
                self._browser_closed = True
                self._status = "browser_closed"
                self._diagnostic_event("⚠️ Navegador cerrado durante el ingreso. Finalizando sin propagar el error.")
                return {"success": False, "status": "browser_closed", "message": "El navegador fue cerrado antes de terminar", "screenshot_path": self._screenshot_path}
            _log(f"❌ Error al unirse: {exc}")
            self._diagnostic_event(f"❌ Error al unirse: {type(exc).__name__}: {exc}")
            traceback.print_exc()
            return {"success": False, "status": "failed", "message": str(exc), "screenshot_path": self._screenshot_path}

    def _body_text(self) -> str:
        try:
            return self.page.locator("body").inner_text(timeout=1500).casefold() if self.page else ""
        except Exception:
            return ""

    def _is_waiting_room(self) -> bool:
        text = self._body_text()
        return any(word in text for word in (
            "waiting in the lobby", "esperando en la sala", "en la sala de espera",
            "esperando a que alguien te admita", "waiting for someone to admit",
            "someone will let you in", "someone in the meeting should let you in",
        ))

    def _meeting_active(self) -> bool:
        return self._detect_join_state() == "joined"

    def _meeting_ended(self) -> bool:
        text = self._body_text()
        return any(phrase in text for phrase in ("meeting has ended", "reunión ha finalizado", "you've been removed", "te quitaron de la reunión"))

    def start_capturing_subtitles(self, callback: Callable[[str], None]) -> None:
        if self._status != "joined" or not self.page:
            raise RuntimeError("El bot debe estar unido antes de capturar subtítulos.")
        self._callback = callback
        self._stop_event.clear()
        _log("🎬 Iniciando captura de subtítulos...")
        try:
            _log(f"   URL actual: {self.page.url}")
            _log(f"   Título de página: {self.page.title()}")
        except Exception as exc:
            if _is_browser_closed_error(exc):
                self._browser_closed = True
                _log("⚠️ El navegador ya estaba cerrado al iniciar la captura.")
                return
            raise
        self._last_diagnostic_at = time.monotonic()
        self._last_screenshot_at = self._last_diagnostic_at
        _log("🎙️ Captura de subtítulos iniciada.")
        # Playwright sync exige usar la página desde el mismo hilo que la creó.
        # Este bucle corre dentro del hilo de trabajo del endpoint.
        self._capture_loop()

    def _activate_captions(self, page: Page) -> bool:
        try:
            # Si el menú ofrece "Desactivar", los subtítulos ya están encendidos.
            for selector in (
                'button:has-text("Turn off live captions")',
                'button:has-text("Desactivar subtítulos")',
            ):
                existing = page.query_selector(selector)
                if existing:
                    self._diagnostic_event("✅ Los subtítulos en vivo ya están activados.")
                    return True

            more_button = page.query_selector('[data-tid="more-actions-button"]')
            if more_button is None:
                for selector in ('button[aria-label*="More actions" i]', 'button[aria-label*="Más acciones" i]'):
                    more_button = page.query_selector(selector)
                    if more_button:
                        break
            if more_button:
                more_button.click()
                page.wait_for_timeout(1500)

            captions_button = page.query_selector(
                'button:has-text("Turn on live captions"), '
                'button:has-text("Activar subtítulos"), '
                'button:has-text("Live captions"), '
                'button:has-text("Subtítulos")'
            )
            if captions_button:
                captions_button.click()
                self._diagnostic_event("✅ Subtítulos activados automáticamente.")
                return True
            self._diagnostic_event("⚠️ No se encontró la opción para activar subtítulos en el menú de Teams.")
            return False
        except Exception as exc:
            if _is_browser_closed_error(exc):
                self._browser_closed = True
            self._diagnostic_event(f"⚠️ No se pudieron activar subtítulos: {exc}")
            return False

    def _log_selector_diagnostics(self, page: Page) -> None:
        elapsed = int(time.monotonic() - (self._started_at or time.monotonic()))
        self._diagnostic_event(f"🔍 [{elapsed}s] Subtítulos capturados: {len(self._segments)}")
        self._diagnostic_event("   Selectores que encuentran algo:")
        for selector in SELECTORES_SUBTITULOS:
            try:
                element = page.query_selector(selector)
                if element:
                    text = element.inner_text()[:100]
                    self._diagnostic_event(f"   ✅ {selector}: {text}")
                else:
                    self._diagnostic_event(f"   ❌ {selector}: no encontrado")
            except Exception as exc:
                if _is_browser_closed_error(exc):
                    self._browser_closed = True
                self._diagnostic_event(f"   ⚠️ {selector}: {exc}")
                if self._browser_closed:
                    break

    def _save_periodic_snapshot(self, page: Page) -> None:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        self._diagnostic_index += 1
        prefix = self.reunion_id or "teams_bot"
        screenshot = LOG_DIR / f"{prefix}_frame_{self._diagnostic_index}.png"
        html = LOG_DIR / f"{prefix}_page_{self._diagnostic_index}.html"
        try:
            page.screenshot(path=str(screenshot), full_page=True, timeout=10000)
            _log(f"🖼️ Screenshot de diagnóstico guardado: {screenshot}")
        except Exception as exc:
            if _is_browser_closed_error(exc):
                self._browser_closed = True
            self._diagnostic_event(f"⚠️ No se pudo guardar screenshot: {exc}")
        else:
            self._diagnostic_event(f"🖼️ Screenshot de diagnóstico guardado: {screenshot.name}")
        try:
            html.write_text(page.content(), encoding="utf-8")
            self._diagnostic_event(f"📄 HTML de diagnóstico guardado: {html.name}")
        except Exception as exc:
            if _is_browser_closed_error(exc):
                self._browser_closed = True
            self._diagnostic_event(f"⚠️ No se pudo guardar HTML: {exc}")

    def _save_final_snapshot(self) -> None:
        page = self.page
        if not page or self._final_snapshot_saved:
            return
        self._final_snapshot_saved = True
        try:
            self._save_periodic_snapshot(page)
        except Exception as exc:
            _log(f"⚠️ No se pudo guardar diagnóstico final: {exc}")

    def _capture_loop(self) -> None:
        end_at = time.monotonic() + self.timeout_seconds
        captions_enabled = False
        try:
            while not self._stop_requested and not self._browser_closed and not self._stop_event.is_set() and time.monotonic() < end_at:
                page = self.page
                if page is None:
                    break
                if self._meeting_ended():
                    _log("🏁 Teams indica que la reunión terminó.")
                    break
                try:
                    if not self._caption_activation_attempted:
                        self._caption_activation_attempted = True
                        captions_enabled = self._activate_captions(page)
                    now = time.monotonic()
                    if now - self._last_diagnostic_at >= 30:
                        self._log_selector_diagnostics(page)
                        self._last_diagnostic_at = now
                    if now - self._last_screenshot_at >= 60:
                        self._save_periodic_snapshot(page)
                        self._last_screenshot_at = now
                    if self._browser_closed:
                        break
                    observer_script = r"""
                        if (!window.__meetiaObserver) {
                          window.__meetiaCaptions = [];
                          window.__meetiaSeen = new Set();
                          const collect = () => {
                            const nodes = document.querySelectorAll(
                              '[data-tid*="caption"], .fui-ChatMessageCompact, [aria-live], [role="log"], span[class*="caption"], div[class*="captionText"]'
                            );
                            nodes.forEach((el) => {
                              const value = (el.innerText || el.textContent || '').trim();
                              value.split(/\n+/).map((line) => line.trim()).filter((line) => line.length > 3).forEach((line) => {
                                if (!window.__meetiaSeen.has(line)) {
                                  window.__meetiaSeen.add(line);
                                  window.__meetiaCaptions.push({ texto: line, timestamp: Date.now() });
                                }
                              });
                              if (window.__meetiaSeen.size > 500) window.__meetiaSeen.clear();
                            });
                          };
                          window.__meetiaObserver = new MutationObserver(collect);
                          if (document.body) window.__meetiaObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
                          collect();
                        }
                    """
                    extract_script = r"""
                        const found = window.__meetiaCaptions || [];
                        window.__meetiaCaptions = [];
                        return found;
                    """
                    frames = page.frames
                    for frame in frames:
                        try:
                            frame.evaluate(observer_script)
                            new_items = frame.evaluate(extract_script)
                        except Exception as frame_exc:
                            if _is_browser_closed_error(frame_exc):
                                raise
                            continue
                        for item in new_items or []:
                            if isinstance(item, dict):
                                self._record_caption(str(item.get("texto", "")))

                    # Fallbacks por DOM para versiones de Teams que no disparan mutaciones útiles.
                    for frame in frames:
                        found_in_frame = False
                        for selector in SELECTORES_SUBTITULOS:
                            element = frame.query_selector(selector)
                            if element:
                                text = " ".join(element.inner_text().split())
                                if len(text) > 2:
                                    self._record_caption(text)
                                    found_in_frame = True
                                    break
                        if found_in_frame:
                            break
                except Exception as exc:
                    if _is_browser_closed_error(exc):
                        self._browser_closed = True
                        self._diagnostic_event("⚠️ Navegador cerrado. Deteniendo captura y conservando subtítulos.")
                        break
                    if not self._reconnected:
                        self._reconnected = True
                        _log(f"🔄 Captura interrumpida; intentando reconectar una vez: {exc}")
                        try:
                            page.reload(wait_until="domcontentloaded", timeout=30000)
                            page.wait_for_timeout(5000)
                        except Exception as reload_exc:
                            if _is_browser_closed_error(reload_exc):
                                self._browser_closed = True
                                self._diagnostic_event("⚠️ Navegador cerrado durante la reconexión.")
                                break
                    else:
                        _log(f"⚠️ Se perdió la conexión a Teams: {exc}")
                        break
                self._stop_event.wait(2)
        except Exception:
            traceback.print_exc()
        finally:
            _log("⏹️ Loop de subtítulos finalizado.")

    def _record_caption(self, text: str) -> None:
        text = " ".join(text.split())
        if len(text) <= 2:
            return
        timestamp = max(0.0, time.monotonic() - (self._started_at or time.monotonic()))
        with self._lock:
            if text in self._seen_captions:
                return
            if len(self._seen_captions) >= 1000:
                self._seen_captions.clear()
            self._segments.append({"timestamp": round(timestamp, 2), "texto": text})
            self._seen_captions.add(text)
        _log(f"💬 Subtítulo capturado: {text}")
        self._save_caption_log()
        if self._callback:
            try:
                self._callback(text)
            except Exception as exc:
                _log(f"⚠️ Callback de subtítulos falló: {exc}")

    def stop(self) -> dict:
        _log("🧹 Cerrando bot y navegador...")
        self._stop_event.set()
        duration = int(time.monotonic() - self._started_at) if self._started_at else 0
        self._save_final_snapshot()
        try:
            try:
                if self.context:
                    self.context.close()
            except Exception:
                pass
            try:
                if self.browser:
                    self.browser.close()
            except Exception:
                pass
            try:
                if self.playwright:
                    self.playwright.stop()
            except Exception:
                pass
        finally:
            self.context = self.browser = self.playwright = None
            self.page = None
            self._release_profile_lock()
        with self._lock:
            segments = list(self._segments)
        return {
            "transcripcion_completa": "\n".join(segment["texto"] for segment in segments),
            "duracion_seg": duration,
            "segmentos": segments,
        }
