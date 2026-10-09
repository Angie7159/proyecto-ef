import base64
import json
import re
import shutil
import threading
import time
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException
from playwright.sync_api import sync_playwright

from app.services.meeting_bot import PROFILE_DIR, _TEAMS_PROFILE_LOCK, _log

router = APIRouter(prefix="/cuentas", tags=["Cuentas"])
_LOGIN_TIMEOUT_SECONDS = 300
_PROFILE_READY_FILE = PROFILE_DIR / ".session_ready"
_STORAGE_STATE_FILE = PROFILE_DIR / "storage_state.json"
_manual_confirmation_event = threading.Event()
_EMAIL_PATTERN = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE)
URLS_EXITO = ("teams.microsoft.com", "outlook.office.com", "outlook.live.com", "m365.cloud.microsoft", "office.com", "microsoft365.com", "www.office.com")


def es_login_exitoso(url: str) -> bool:
    lower = url.casefold()
    if any(pattern.casefold() in lower for pattern in URLS_EXITO):
        return True
    excluded = ("login.microsoftonline.com", "login.live.com", "account.microsoft.com", "signup.live.com")
    return not any(domain in lower for domain in excluded) and "microsoft" in lower


def _email_from_cookies(cookies: list[dict]) -> tuple[str | None, str | None]:
    for cookie in cookies:
        value = str(cookie.get("value", ""))
        direct_match = _EMAIL_PATTERN.search(value)
        if direct_match:
            return direct_match.group(0), None
        parts = value.split(".")
        for part in parts:
            if not part or len(part) < 20:
                continue
            try:
                decoded = base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)).decode("utf-8")
                claims = json.loads(decoded)
            except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(claims, dict):
                continue
            email = next((
                str(claims.get(key)).strip()
                for key in ("preferred_username", "upn", "email", "unique_name")
                if claims.get(key) and _EMAIL_PATTERN.fullmatch(str(claims[key]).strip())
            ), None)
            if email:
                return email, str(claims.get("name") or "").strip() or None
            for item in claims.values():
                if isinstance(item, str):
                    match = _EMAIL_PATTERN.search(item)
                    if match:
                        return match.group(0), str(claims.get("name") or "").strip() or None
    return None, None


def _email_from_page(page) -> tuple[str | None, str | None]:
    try:
        email = page.evaluate(r"""() => {
          const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
          try { for (let i=0; i<localStorage.length; i++) { const v=localStorage.getItem(localStorage.key(i)); const m=v && v.match(re); if (m) return m[0]; } } catch (_) {}
          for (const el of document.querySelectorAll('[aria-label*="@"], [data-tid*="user"]')) { const m=(el.innerText || el.getAttribute('aria-label') || '').match(re); if (m) return m[0]; }
          for (const el of document.querySelectorAll('span, div')) { const t=el.innerText || ''; if (t.includes('@') && t.length < 100) { const m=t.match(re); if (m) return m[0]; } }
          return null;
        }""")
        if email:
            try: name = page.title().strip() or None
            except Exception: name = None
            return email, name
    except Exception:
        pass
    try:
        body = page.locator("body").inner_text(timeout=2000)
    except Exception:
        return None, None
    match = _EMAIL_PATTERN.search(body)
    if not match:
        return None, None
    name = None
    try:
        name = page.title().strip() or None
    except Exception:
        pass
    return match.group(0), name


def _tiene_sesion_valida(cookies: list) -> tuple[bool, str]:
    cookies_auth = (
        "ESTSAUTH", "ESTSAUTHPERSISTENT", "AADSSO", "SSOCOOKIE",
        "RpsAuthToken", "X-AnchorMailbox", "authtoken", "SignInStateCookie",
    )
    dominios_ms = ("microsoft.com", "microsoftonline.com", "live.com", "office.com", "office365.com", "sharepoint.com")
    auth_encontradas = []
    for cookie in cookies:
        nombre = cookie.get("name", "")
        dominio = cookie.get("domain", "")
        if any(auth_name.lower() in nombre.lower() for auth_name in cookies_auth):
            auth_encontradas.append(f"{nombre}@{dominio}")
    dominios_ok = any(any(dom in cookie.get("domain", "") for dom in dominios_ms) for cookie in cookies)
    _log(f"🍪 Cookies de autenticación encontradas: {len(auth_encontradas)}")
    for cookie in auth_encontradas[:10]:
        _log(f"   - {cookie}")
    if len(auth_encontradas) >= 2 and dominios_ok:
        return True, f"Sesión válida ({len(auth_encontradas)} cookies de auth)"
    if len(auth_encontradas) >= 1 and len(cookies) >= 15:
        return True, "Sesión parcial pero funcional"
    return False, f"Solo {len(auth_encontradas)} cookies de auth, {len(cookies)} totales"


def _guardar_storage_state_de_teams(page, context) -> tuple[bool, str]:
    current_url = page.url.casefold()
    if "teams.microsoft.com" in current_url:
        _log("Sesión de Teams ya abierta; esperando 5 segundos antes de exportar.")
        page.wait_for_timeout(5000)
    else:
        _log("🌐 Navegando a Teams para generar cookies...")
        try:
            page.goto("https://teams.microsoft.com/", wait_until="domcontentloaded", timeout=60000)
        except Exception as exc:
            _log(f"⚠️ Error navegando a Teams: {exc}")
        _log("⏳ Esperando 15 segundos a que Teams cargue completamente...")
        page.wait_for_timeout(15000)

    _log(f"📄 URL actual: {page.url}")
    if "launcher" in page.url.lower():
        _log("⚠️ Teams redirigió al launcher, esperando...")
        page.wait_for_timeout(10000)
        _log(f"📄 URL después de esperar: {page.url}")

    url_actual = page.url.casefold()
    if "login.microsoftonline.com" in url_actual or "login.live.com" in url_actual:
        raise RuntimeError("Aún estás en la pantalla de login. Completa el login hasta llegar a Teams.")
    if "teams.microsoft.com" not in url_actual:
        _log(f"⚠️ URL no es de Teams: {page.url}")
        _log("Esperando 30 segundos más a que llegues a Teams...")
        page.wait_for_timeout(30000)
        url_actual = page.url.casefold()
        if "login.microsoftonline.com" in url_actual or "login.live.com" in url_actual:
            raise RuntimeError("Aún estás en la pantalla de login. Completa el login hasta llegar a Teams.")
        if "teams.microsoft.com" not in url_actual:
            raise RuntimeError("No se llegó a Teams. Deja abierta la ventana hasta ver la pantalla principal.")

    url_actual = page.url
    if "teams.microsoft.com" not in url_actual.casefold():
        raise RuntimeError(f"No se llegó a Teams. URL actual: {url_actual}")
    cookies = context.cookies()
    _log(f"🍪 Total de cookies: {len(cookies)}")
    valido, motivo = _tiene_sesion_valida(cookies)
    _log(f"✅ Validación de sesión: {motivo}" if valido else f"⚠️ {motivo}; se guarda porque llegaste a Teams.")
    _STORAGE_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    context.storage_state(path=str(_STORAGE_STATE_FILE))
    _log(f"✅ storageState guardado (URL: {url_actual})")
    return valido, motivo


@router.post("/conectar-microsoft")
def conectar_microsoft() -> dict:
    if not _TEAMS_PROFILE_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="El perfil Microsoft está siendo usado por un bot. Intenta de nuevo cuando termine.")

    context = None
    started_at = time.monotonic()
    _manual_confirmation_event.clear()
    try:
        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=str(PROFILE_DIR),
                headless=False,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-default-browser-check",
                    "--disable-component-update",
                ],
                viewport={"width": 1280, "height": 800},
            )
            page = context.pages[0] if context.pages else context.new_page()
            page.goto("https://login.microsoftonline.com/", wait_until="domcontentloaded", timeout=60000)
            _log("🔐 Chromium abierto. Inicia sesión con tu cuenta Microsoft.")

            while time.monotonic() - started_at < _LOGIN_TIMEOUT_SECONDS:
                if _manual_confirmation_event.is_set():
                    data = _read_session_marker()
                    _guardar_storage_state_de_teams(page, context)
                    email = data.get("email") or "cuenta_conectada"
                    _PROFILE_READY_FILE.write_text(email, encoding="utf-8")
                    context.close()
                    context = None
                    return {"success": True, "email": email, "nombre": data.get("nombre")}
                current_url = page.url
                if es_login_exitoso(current_url):
                    email, name = _email_from_cookies(context.cookies())
                    if not email:
                        email, page_name = _email_from_page(page)
                        name = name or page_name
                    email = email or "cuenta_conectada"
                    _guardar_storage_state_de_teams(page, context)
                    _PROFILE_READY_FILE.write_text(email, encoding="utf-8")
                    _log(f"Sesion Microsoft lista{f' para {email}' if email else ' (email no visible)'} en {current_url}")
                    context.close()
                    context = None
                    return {"success": True, "email": email, "nombre": name}
                page.wait_for_timeout(3000)

            if context:
                context.close()
                context = None

        raise HTTPException(
            status_code=408,
            detail="No se detectó el inicio de sesión de Microsoft en 5 minutos. Intenta conectar de nuevo.",
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"No se pudo conectar la cuenta Microsoft: {exc}") from exc
    finally:
        if context:
            try:
                context.close()
            except Exception:
                pass
        _TEAMS_PROFILE_LOCK.release()


@router.get("/estado")
def estado_cuenta_microsoft() -> dict:
    if not _PROFILE_READY_FILE.is_file():
        return {"conectada": False, "email": None, "fecha_conexion": None}
    try:
        raw = _PROFILE_READY_FILE.read_text(encoding="utf-8").strip()
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = {"email": raw}
        return {
            "conectada": bool(data.get("conectada", True)),
            "email": data.get("email"),
            "fecha_conexion": data.get("fecha_conexion"),
        }
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"No se pudo leer el estado de la cuenta Microsoft: {exc}") from exc


def _read_session_marker() -> dict:
    try:
        raw = _PROFILE_READY_FILE.read_text(encoding="utf-8").strip()
        data = json.loads(raw)
        return data if isinstance(data, dict) else {"conectada": True, "email": None}
    except (OSError, json.JSONDecodeError):
        return {"conectada": True, "email": None}


@router.post("/confirmar-conexion")
def confirmar_conexion() -> dict:
    if not PROFILE_DIR.is_dir():
        raise HTTPException(status_code=400, detail="No hay navegador abierto")
    existing = _read_session_marker()
    marker = {
        "conectada": True,
        "email": existing.get("email"),
        "nombre": existing.get("nombre"),
        "fecha_conexion": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    try:
        _PROFILE_READY_FILE.write_text(json.dumps(marker, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"No se pudo guardar la sesión Microsoft: {exc}") from exc
    _manual_confirmation_event.set()
    return {"success": True, "email": marker["email"], "mensaje": "Conexión Microsoft confirmada"}

@router.delete("/desconectar")
def desconectar_microsoft() -> dict:
    if not _TEAMS_PROFILE_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="No se puede desconectar mientras un bot está usando la cuenta Microsoft.")
    try:
        profile_path = PROFILE_DIR.resolve()
        expected_parent = Path(__file__).resolve().parents[2]
        if profile_path.parent != expected_parent or profile_path.name != "bot_profile_teams":
            raise HTTPException(status_code=500, detail="La ruta del perfil Microsoft no es válida.")
        if profile_path.exists():
            shutil.rmtree(profile_path)
        return {"success": True}
    except HTTPException:
        raise
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"No se pudo eliminar la sesión Microsoft: {exc}") from exc
    finally:
        _TEAMS_PROFILE_LOCK.release()
