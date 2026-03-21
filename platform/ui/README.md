# TekNaBox — Web UI

React SPA for the TekNaBox MSP Remote Management Platform.

## Development

```bash
npm install
npm run dev
# → http://localhost:5173
# API calls are proxied to http://localhost:8005 via Vite
```

## Production Build

```bash
npm run build
# Output in dist/
```

## Serving via the FastAPI server

Add the built `dist/` folder to the server and serve it as static files.
Add this to `app/main.py`:

```python
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

# After all API routes:
app.mount("/assets", StaticFiles(directory="dist/assets"), name="assets")

@app.get("/{full_path:path}")
async def serve_ui(full_path: str):
    return FileResponse("dist/index.html")
```

Then copy `dist/` into the server container and rebuild.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_BASE` | `""` (proxied) | API base URL for production builds |

For production, set in `.env.local`:
```
VITE_API_BASE=https://yourserver.com
```
