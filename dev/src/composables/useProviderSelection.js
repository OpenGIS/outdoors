import { computed, ref, watch } from "vue";
import rawProviders from "../providers.json";

const SELECTED_STORAGE = "outdoors_dev_selected";
const DEFAULT_PROVIDER_KEY = "opengis-basemap";

/**
 * Provider selection state for the compare app: builds the grouped
 * provider list, holds the selected provider key, and keeps the
 * selection validated and persisted in localStorage.
 *
 * Returns:
 * - sections: providers grouped by category (for the select)
 * - allProviders: flat list for quick lookup
 * - selectedKey: writable ref bound via v-model
 * - selectedEntry: the full provider object for the current selection
 */
export function useProviderSelection() {
  const providerConfig = ref(rawProviders);

  // ── Build sections from available providers ──
  const sections = computed(() => {
    const result = [];

    // Merge remote vectors and rasters, group by category
    const allRemote = [];
    for (const p of providerConfig.value.remoteVector || []) {
      allRemote.push({ ...p });
    }
    for (const p of providerConfig.value.remoteRaster || []) {
      allRemote.push({ ...p });
    }

    // Group by category
    const grouped = {};
    for (const p of allRemote) {
      const cat = p.category || "Other";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(p);
    }

    // Sort categories alphabetically, then providers by label
    const sortedCats = Object.keys(grouped).sort((a, b) => a.localeCompare(b));
    for (const cat of sortedCats) {
      grouped[cat].sort((a, b) => a.label.localeCompare(b.label));
      result.push({ label: cat, providers: grouped[cat] });
    }

    return result;
  });

  // ── Flat list for quick provider lookup ──
  const allProviders = computed(() =>
    sections.value.flatMap((s) => s.providers),
  );

  // ── Selected provider ──
  const selectedKey = ref(localStorage.getItem(SELECTED_STORAGE) || "");

  // Validate / initialise selection when providers become available
  watch(
    allProviders,
    (providers) => {
      if (!providers.length) return;
      const saved = localStorage.getItem(SELECTED_STORAGE);
      if (saved && providers.find((p) => p.key === saved)) {
        selectedKey.value = saved;
      } else {
        // Default to the OpenGIS Basemap; fall back to the first provider
        // that doesn't require an API key (avoids key prompts on page load).
        const defaultProvider =
          providers.find((p) => p.key === DEFAULT_PROVIDER_KEY) ??
          providers.find((p) => !p.apiKey) ??
          providers[0];
        selectedKey.value = defaultProvider?.key ?? "";
        // Persist immediately — the persist watcher below is registered too late
        // to observe this correction (this watch runs at setup, with immediate).
        localStorage.setItem(SELECTED_STORAGE, selectedKey.value);
      }
    },
    { immediate: true },
  );

  // Persist selection
  watch(selectedKey, (key) => {
    if (key) localStorage.setItem(SELECTED_STORAGE, key);
  });

  const selectedEntry = computed(() =>
    allProviders.value.find((p) => p.key === selectedKey.value),
  );

  return { sections, allProviders, selectedKey, selectedEntry };
}
