# Contour Vector Tile Server

Self-hosted on-demand contour line tiles for the outdoor map style. Runs [contour-mvt-server](https://github.com/acalcutt/contour-mvt-server) which generates vector contour tiles from Mapterhorn DEM data in real-time using marching squares.

## Quick start

```bash
cd contours
npm install    # one-time setup
npm start      # starts on port 11001
```

Verify it's running:

```bash
curl http://localhost:11001/health
# {"status":"ok","sources":["terrain"],"version":"1.0.0"}
```

Fetch a tile:

```bash
curl -sS -o /dev/null -w "%{http_code} %{size_download}B" \
  "http://localhost:11001/contours/terrain/12/2207/1538.pbf"
# 200 4458B
```

## Stop

```bash
kill $(lsof -ti:11001)
```

## Configuration

Settings in `config.json`:

- **DEM source:** Mapterhorn (`tiles.mapterhorn.com`) — Terrarium encoding, 512px WebP tiles, maxzoom 15
- **Contour thresholds:**
  - z10–12: 20m minor, 100m major (matches TrailSplits)
  - z13: 10m minor, 50m major
  - z14: 5m minor, 25m major
- **Output:** gzipped PBF with `ele` (elevation in m) and `level` (0=minor, 1=major) properties

### Switching to the AWS Terrarium DEM source

To use AWS Terrarium instead (256px PNG tiles, slightly faster but less detail), change the `tiles` value in `config.json`:

```json
{
  "tiles": "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
}
```

## Usage in style

The outdoor build script (`scripts/build.mjs`) points at the local server:

```
http://localhost:11001/contours/terrain/{z}/{x}/{y}.pbf
```

Filter on `ele % 100 == 0` for index lines (100 m) or use the `level` property.
