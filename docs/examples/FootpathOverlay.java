/**
 * Planetiler Java profile for low-zoom outdoor path vector tiles.
 *
 * Generates an overlay of footpaths (highway=path|footway|track) at
 * zoom levels 9-13, filling the gap where the OpenMapTiles base schema
 * emits no path geometry below z14. Hiking route network tier gates
 * density below z12 — route-gated below, everything at z12.
 *
 * Density strategy, mirroring the Mapzen/Tilezen proposal
 * (vector-datasource issue #596):
 *
 *   | Best route membership | min zoom |
 *   |-----------------------|----------|
 *   | iwn                   | 9        |
 *   | nwn                   | 10       |
 *   | rwn                   | 11       |
 *   | lwn                   | 12       |
 *   | none (not routed)     | 12       |
 *
 * (All paths appear from z12 — since 2026-08-03; network tiers keep earlier
 * zooms so long-distance routes still lead when zoomed out.)
 *
 * Three-phase processing:
 *   1. preprocessOsmRelation — store route relation network tier
 *   2. processFeature — emit line features for matched ways
 *   3. postProcessLayerFeatures — merge touching line segments
 *
 * Usage:
 *   java -cp ../.planetiler/planetiler.jar build/FootpathOverlay.java \
 *     --area=italy --download --bounds=10.48,45.27,11.78,46.18
 *
 * Output: paths/outdoor_paths.pmtiles
 */

import com.onthegomap.planetiler.FeatureCollector;
import com.onthegomap.planetiler.FeatureMerge;
import com.onthegomap.planetiler.Planetiler;
import com.onthegomap.planetiler.Profile;
import com.onthegomap.planetiler.VectorTile;
import com.onthegomap.planetiler.config.Arguments;
import com.onthegomap.planetiler.reader.SourceFeature;
import com.onthegomap.planetiler.reader.osm.OsmElement;
import com.onthegomap.planetiler.reader.osm.OsmRelationInfo;
import java.nio.file.Path;
import java.util.List;

public class FootpathOverlay implements Profile {

  /**
   * Minimal container for hiking route relation data held in RAM during processing.
   */
  private record PathRelationInfo(
    long id,
    String network
  ) implements OsmRelationInfo {}

  /**
   * Phase 1: Extract hiking route relation network tiers.
   *
   * Matches OSM relations with:
   *   type = route | superroute
   *   route = hiking | foot | walking
   *
   * Stores the relation id and the network tier (iwn/nwn/rwn/lwn,
   * null when untagged) for each matched relation.
   */
  @Override
  public List<OsmRelationInfo> preprocessOsmRelation(OsmElement.Relation relation) {
    if (relation.hasTag("type", "route", "superroute")) {
      String route = relation.getString("route");
      if (route != null) {
        // Support semicolon-separated values: "hiking;foot"
        for (var r : route.split(";")) {
          r = r.trim();
          if (r.equals("hiking") || r.equals("foot") || r.equals("walking")) {
            return List.of(new PathRelationInfo(
              relation.id(),
              // Map network abbreviation to tier
              switch (relation.getString("network", "")) {
                case "iwn" -> "iwn";
                case "nwn" -> "nwn";
                case "rwn" -> "rwn";
                case "lwn" -> "lwn";
                default -> null;
              }
            ));
          }
        }
      }
    }
    return null;
  }

  /**
   * Phase 2: Emit line features for footpath ways.
   *
   * Each way with highway=path|footway|track emits a line string in the
   * outdoor_paths layer. The way's minimum zoom is the lowest zoom
   * among its route relation memberships (iwn z9 … lwn z12); ways with
   * no membership appear only at z12.
   */
  @Override
  public void processFeature(SourceFeature sourceFeature, FeatureCollector features) {
    if (!sourceFeature.canBeLine()) return;

    String highway = sourceFeature.getString("highway");
    if (highway == null) return;

    // Support semicolon-separated values: "path;footway"
    String pathClass = null;
    for (var h : highway.split(";")) {
      h = h.trim();
      if (h.equals("path") || h.equals("footway") || h.equals("track")) {
        pathClass = h;
        break;
      }
    }
    if (pathClass == null) return;

    // Get all hiking route relations this way belongs to
    var routeInfos = sourceFeature.relationInfo(PathRelationInfo.class, true);

    // Lowest zoom among member relation tiers wins; no membership → 12
    // (all paths appear from z12 — changed 2026-08-03 per Joe: "all paths at
    // z12"; long-distance tiers keep their earlier zooms: iwn 9, nwn 10, rwn 11).
    String network = null;
    int minZoom = 12;
    if (routeInfos != null) {
      for (var routeInfo : routeInfos) {
        String tier = routeInfo.relation().network;
        int zoom = tier == null ? 12 : switch (tier) {
          case "iwn" -> 9;
          case "nwn" -> 10;
          case "rwn" -> 11;
          case "lwn" -> 12;
          default -> 12;
        };
        if (zoom < minZoom) {
          minZoom = zoom;
          network = tier;
        }
      }
    }

    features.line("outdoor_paths")
      .setAttr("class", pathClass)
      .setAttr("network", network)
      .setAttr("name", sourceFeature.getString("name"))
      .setAttr("sac_scale", sourceFeature.getString("sac_scale"))
      .setZoomRange(minZoom, 13)
      // Don't filter short segments — needed for line merging in phase 3
      .setMinPixelSize(0);
  }

  /**
   * Phase 3: Merge touching line segments in each tile before writing.
   *
   * Footpath ways are fragmented at every junction. This merges adjacent
   * ways that share the same tags into continuous linestrings, which
   * improves both visual rendering and label placement.
   */
  @Override
  public List<VectorTile.Feature> postProcessLayerFeatures(
    String layer, int zoom, List<VectorTile.Feature> items
  ) {
    if ("outdoor_paths".equals(layer)) {
      return FeatureMerge.mergeLineStrings(
        items,
        0.5,   // min length in px after merging
        0.1,   // simplification tolerance
        4      // detail outside tile boundary
      );
    }
    return items;
  }

  // ── Metadata ────────────────────────────────────────────────────

  @Override
  public String name() {
    return "Outdoor Paths";
  }

  @Override
  public String description() {
    return "Footpaths (path, footway, track) with hiking route network tiers from OpenStreetMap";
  }

  @Override
  public boolean isOverlay() {
    return true;
  }

  @Override
  public String attribution() {
    return """
      <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>
      """.trim();
  }

  // ── Entrypoint ──────────────────────────────────────────────────

  public static void main(String[] args) throws Exception {
    var arguments = Arguments.fromArgsOrConfigFile(args)
      .withDefault("download", true)
      .withDefault("maxzoom", 13);

    String area = arguments.getString("area", "geofabrik area", "italy");

    // Resolve paths relative to the features/ directory
    Path dataDir = Path.of("data", "sources");
    Path osmPath = dataDir.resolve(area + ".osm.pbf");
    Path outputPath = Path.of("paths", "outdoor_paths.pmtiles");
    String url = "geofabrik:" + area;

    Planetiler.create(arguments)
      .setProfile(new FootpathOverlay())
      .addOsmSource("osm", osmPath, url)
      .overwriteOutput(outputPath)
      .run();

    System.out.println("✓ Outdoor paths tiles written to " + outputPath);
  }
}
