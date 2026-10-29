/**
 * Planetiler Java profile for outdoor route vector tiles.
 *
 * Processes OSM hiking and cycling route relations (type=route,
 * route=hiking|foot|walking for hiking, route=bicycle for cycling) and emits
 * line features for each member way, tagged with relation-level attributes
 * (name, ref, network, osmc:symbol, etc.).
 *
 * A way may belong to more than one activity (for example a relation tagged
 * route=hiking;bicycle). Each matched relation therefore emits one feature per
 * surviving activity, all carrying the same `activities` string — the full set
 * of activities the way belongs to, in priority order, highest first (e.g.
 * "hiking;cycling"). The style's own registry is draw order (cycling below,
 * hiking on top), which is a separate concern from this priority ordering.
 *
 * Patterned on Planetiler's BikeRouteOverlay example:
 *   https://github.com/onthegomap/planetiler/blob/main/planetiler-examples/src/main/java/com/onthegomap/planetiler/examples/BikeRouteOverlay.java
 *
 * Three-phase processing:
 *   1. preprocessOsmRelation — store route relation info per activity
 *   2. processFeature — emit line features for matched ways
 *   3. postProcessLayerFeatures — merge touching line segments
 *
 * Usage:
 *   java -cp ../.planetiler/planetiler.jar docs/examples/RouteOverlay.java \
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
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;

public class RouteOverlay implements Profile {

  /**
   * Descriptor for one route activity.
   *
   * @param id          the activity id emitted as `activity` ("hiking" or "cycling")
   * @param routeTokens `route` tag tokens that identify this activity
   * @param networks    the network abbreviations in this activity's vocabulary
   * @param excluded    relation-level exclusions applied to this activity only
   */
  private record RouteActivity(
    String id,
    Set<String> routeTokens,
    Set<String> networks,
    Predicate<OsmElement.Relation> excluded
  ) {}

  /**
   * Activity registry, in priority order, highest first.
   *
   * This order defines the `activities` string ("hiking;cycling"). It is not
   * the style's draw order — the style draws cycling below and hiking on top —
   * so keep the two lists separate.
   *
   * Exclusions are per activity: a proposed or node-network cycling relation
   * drops cycling but can still keep hiking if it also matches. Hiking has no
   * exclusions.
   */
  private static final List<RouteActivity> ACTIVITIES = List.of(
    new RouteActivity(
      "hiking",
      Set.of("hiking", "foot", "walking"),
      Set.of("iwn", "nwn", "rwn", "lwn"),
      relation -> false
    ),
    new RouteActivity(
      "cycling",
      Set.of("bicycle"),
      Set.of("icn", "ncn", "rcn", "lcn"),
      relation -> relation.hasTag("state", "proposed")
        // Node networks are dense, short-hop route webs out of scope here.
        || relation.hasTag("network:type", "node_network")
    )
  );

  /**
   * Minimal container for outdoor route relation data held in RAM during processing.
   *
   * One instance is produced per relation per surviving activity, so `activity`
   * is this feature's activity while `activities` is the full set the way
   * belongs to, in priority order, highest first.
   */
  private record RouteRelationInfo(
    long id,
    String name,
    String ref,
    String activity,
    String activities,
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
   * Phase 1: Extract outdoor route relation data.
   *
   * Matches OSM relations with:
   *   type = route | superroute
   *   route contains a token from any registry activity
   *
   * Every registry activity whose tokens match is kept, after applying that
   * activity's own exclusions. `activities` is the joined set of survivors in
   * priority order. One RouteRelationInfo is returned per surviving activity;
   * if none survive, returns null.
   *
   * Stores name, ref, activity, activities, network, osmc:symbol, operator,
   * distance, ascent, descent, cai_scale, and roundtrip for each match.
   */
  @Override
  public List<OsmRelationInfo> preprocessOsmRelation(OsmElement.Relation relation) {
    if (!relation.hasTag("type", "route", "superroute")) {
      return null;
    }
    String route = relation.getString("route");
    if (route == null) {
      return null;
    }

    // Support semicolon-separated values: "hiking;foot"
    Set<String> routeTokens = new HashSet<>();
    for (String token : route.split(";")) {
      String trimmed = token.trim();
      if (!trimmed.isEmpty()) {
        routeTokens.add(trimmed);
      }
    }

    List<RouteActivity> surviving = new ArrayList<>();
    for (var activity : ACTIVITIES) {
      if (activity.excluded().test(relation)) {
        continue;
      }
      if (routeTokens.stream().anyMatch(activity.routeTokens()::contains)) {
        surviving.add(activity);
      }
    }
    if (surviving.isEmpty()) {
      return null;
    }

    String activities = String.join(
      ";",
      surviving.stream().map(RouteActivity::id).toList()
    );

    // Keep the whole-value network; do not split on semicolons.
    String rawNetwork = relation.getString("network", "");

    List<OsmRelationInfo> result = new ArrayList<>(surviving.size());
    for (var activity : surviving) {
      // Normalise the network to this activity's own vocabulary.
      String network = activity.networks().contains(rawNetwork) ? rawNetwork : null;

      result.add(new RouteRelationInfo(
        relation.id(),
        relation.getString("name"),
        relation.getString("ref"),
        activity.id(),
        activities,
        network,
        relation.getString("osmc:symbol"),
        relation.getString("operator"),
        relation.getString("distance"),
        relation.getString("ascent"),
        relation.getString("descent"),
        relation.getString("cai_scale"),
        relation.getString("roundtrip")
      ));
    }
    return result;
  }

  /**
   * Phase 2: Emit line features for ways that belong to route relations.
   *
   * Each way member of a matched relation emits a line string in the
   * outdoor_routes layer for every surviving activity, with the relation's
   * attributes attached.
   */
  @Override
  public void processFeature(SourceFeature sourceFeature, FeatureCollector features) {
    if (sourceFeature.canBeLine()) {
      // Get all route relations this way belongs to
      var routeInfos = sourceFeature.relationInfo(RouteRelationInfo.class, true);
      if (routeInfos == null) return;

      for (var routeInfo : routeInfos) {
        RouteRelationInfo rel = routeInfo.relation();

        var feature = features.line("outdoor_routes")
          .setAttr("name", rel.name)
          .setAttr("ref", rel.ref)
          .setAttr("activity", rel.activity)
          .setAttr("activities", rel.activities)
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
    return "Hiking (hiking, foot, walking) and cycling (bicycle) route relations from OpenStreetMap, " +
      "emitted per activity with an activities set in priority order";
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

    // Resolve paths relative to the process working directory
    Path dataDir = Path.of("data", "sources");
    Path osmPath = dataDir.resolve(area + ".osm.pbf");
    Path outputPath = Path.of("routes", "outdoor_routes.pmtiles");
    String url = "geofabrik:" + area;

    Planetiler.create(arguments)
      .setProfile(new RouteOverlay())
      .addOsmSource("osm", osmPath, url)
      .overwriteOutput(outputPath)
      .run();

    System.out.println("✓ Outdoor routes tiles written to " + outputPath);
  }
}
