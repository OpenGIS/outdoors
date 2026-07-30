/**
 * Planetiler Java profile for outdoor hiking route vector tiles.
 *
 * Processes OSM hiking route relations (type=route, route=hiking|foot|walking)
 * and emits line features for each member way, tagged with relation-level
 * attributes (name, ref, network, osmc:symbol, etc.).
 *
 * Patterned on Planetiler's BikeRouteOverlay example:
 *   https://github.com/onthegomap/planetiler/blob/main/planetiler-examples/src/main/java/com/onthegomap/planetiler/examples/BikeRouteOverlay.java
 *
 * Three-phase processing:
 *   1. preprocessOsmRelation — store route relation info
 *   2. processFeature — emit line features for matched ways
 *   3. postProcessLayerFeatures — merge touching line segments
 *
 * Usage:
 *   java -cp ../.planetiler/planetiler.jar scripts/HikingRouteOverlay.java \
 *     --area=italy --download --bounds=10.48,45.27,11.78,46.18
 *
 * Output: routes/outdoor_routes.pmtiles
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

public class HikingRouteOverlay implements Profile {

  /**
   * Minimal container for hiking route relation data held in RAM during processing.
   */
  private record RouteRelationInfo(
    long id,
    String name,
    String ref,
    String network,
    String osmcSymbol,
    String operator,
    String distance,
    String ascent,
    String descent,
    String caiScale,
    String roundtrip
  ) implements OsmRelationInfo {}

  /**
   * Phase 1: Extract hiking route relation data.
   *
   * Matches OSM relations with:
   *   type = route | superroute
   *   route = hiking | foot | walking
   *
   * Stores name, ref, network, osmc:symbol, operator, distance,
   * ascent, descent, cai_scale, and roundtrip for each matched relation.
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
            return List.of(new RouteRelationInfo(
              relation.id(),
              relation.getString("name"),
              relation.getString("ref"),
              // Map network abbreviation to human-readable
              switch (relation.getString("network", "")) {
                case "iwn" -> "iwn";
                case "nwn" -> "nwn";
                case "rwn" -> "rwn";
                case "lwn" -> "lwn";
                default -> null;
              },
              relation.getString("osmc:symbol"),
              relation.getString("operator"),
              relation.getString("distance"),
              relation.getString("ascent"),
              relation.getString("descent"),
              relation.getString("cai_scale"),
              relation.getString("roundtrip")
            ));
          }
        }
      }
    }
    return null;
  }

  /**
   * Phase 2: Emit line features for ways that belong to hiking route relations.
   *
   * Each way member of a matched relation emits a line string in the
   * outdoor_routes layer with the relation's attributes attached.
   */
  @Override
  public void processFeature(SourceFeature sourceFeature, FeatureCollector features) {
    if (sourceFeature.canBeLine()) {
      // Get all hiking route relations this way belongs to
      var routeInfos = sourceFeature.relationInfo(RouteRelationInfo.class, true);
      if (routeInfos == null) return;

      for (var routeInfo : routeInfos) {
        RouteRelationInfo rel = routeInfo.relation();

        var feature = features.line("outdoor_routes")
          .setAttr("name", rel.name)
          .setAttr("ref", rel.ref)
          .setAttr("network", rel.network)
          .setAttr("osmc_symbol", rel.osmcSymbol)
          .setAttr("operator", rel.operator)
          .setAttr("distance", rel.distance)
          .setAttr("ascent", rel.ascent)
          .setAttr("descent", rel.descent)
          .setAttr("cai_scale", rel.caiScale)
          .setAttr("roundtrip", rel.roundtrip)
          .setZoomRange(8, 14)
          // Don't filter short segments — needed for line merging in phase 3
          .setMinPixelSize(0);
      }
    }
  }

  /**
   * Phase 3: Merge touching line segments in each tile before writing.
   *
   * Route relations are composed of multiple ways. This merges adjacent
   * ways that share the same tags into continuous linestrings, which
   * improves both visual rendering and label placement.
   */
  @Override
  public List<VectorTile.Feature> postProcessLayerFeatures(
    String layer, int zoom, List<VectorTile.Feature> items
  ) {
    if ("outdoor_routes".equals(layer)) {
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
    return "Outdoor Routes";
  }

  @Override
  public String description() {
    return "Hiking route relations (hiking, foot, walking) from OpenStreetMap";
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
      .withDefault("maxzoom", 14);

    String area = arguments.getString("area", "geofabrik area", "italy");

    // Resolve paths relative to the features/ directory
    Path dataDir = Path.of("data", "sources");
    Path osmPath = dataDir.resolve(area + ".osm.pbf");
    Path outputPath = Path.of("routes", "outdoor_routes.pmtiles");
    String url = "geofabrik:" + area;

    Planetiler.create(arguments)
      .setProfile(new HikingRouteOverlay())
      .addOsmSource("osm", osmPath, url)
      .overwriteOutput(outputPath)
      .run();

    System.out.println("✓ Outdoor routes tiles written to " + outputPath);
  }
}
