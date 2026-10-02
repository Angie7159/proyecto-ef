from app.config import get_settings

s = get_settings()
k = s.groq_api_key

# Si es SecretStr, extraer el valor real
if hasattr(k, "get_secret_value"):
    k = k.get_secret_value()

print("Empieza con gsk_:", k.startswith("gsk_"))
print("Longitud:", len(k))
print("Tiene espacios:", " " in k)
print("Tiene saltos de linea:", "\n" in k or "\r" in k)
print("Tiene comillas dobles:", '"' in k)
print("Tiene comillas simples:", "'" in k)
print("Primeros 8 caracteres:", k[:8])
print("Ultimos 4 caracteres:", k[-4:])