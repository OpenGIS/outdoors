<script setup>
defineProps({
  sections: {
    type: Array,
    default: () => [],
  },
  modelValue: {
    type: String,
    default: "",
  },
});

const emit = defineEmits(["update:modelValue"]);

function onChange(e) {
  emit("update:modelValue", e.target.value);
}
</script>

<template>
  <select :value="modelValue" @change="onChange" class="provider-select">
    <button type="button">
      <selectedcontent></selectedcontent>
    </button>
    <optgroup
      v-for="section in sections"
      :key="section.label"
      :label="section.label"
    >
      <legend>{{ section.label }}</legend>
      <option
        v-for="provider in section.providers"
        :key="provider.key"
        :value="provider.key"
      >
        {{ provider.label }}
      </option>
    </optgroup>
  </select>
</template>

<style>
/* ── Base: opt in to custom select rendering ── */
.provider-select,
::picker(select) {
  appearance: base-select;
}

/* ── Closed-state button ── */
.provider-select {
  font-size: 14px;
  padding: 6px 10px;
  border: 1px solid #ccc;
  border-radius: 4px;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
  cursor: pointer;
  min-width: 200px;
}

/* ── Picker icon (down arrow) ── */
.provider-select::picker-icon {
  color: #888;
  transition: 0.2s rotate;
}

.provider-select:open::picker-icon {
  rotate: 180deg;
}

/* ── Dropdown picker ── */
::picker(select) {
  border: 1px solid #ccc;
  border-radius: 4px;
  background: #fff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  padding: 4px 0;
  /* fade-in transition */
  opacity: 0;
  transition: opacity 0.15s allow-discrete;
}

:open::picker(select) {
  opacity: 1;
}

@starting-style {
  :open::picker(select) {
    opacity: 0;
  }
}

/* ── Position picker below the select button ── */
::picker(select) {
  top: calc(anchor(bottom) + 2px);
  left: anchor(left);
  width: anchor-size(width);
}

/* ── Optgroup sections ── */
optgroup {
  padding: 0;
  margin: 0;
}

optgroup legend {
  display: block;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #888;
  padding: 8px 10px 2px;
  border-top: 1px solid #eee;
  width: 100%;
}

optgroup:first-of-type legend {
  border-top: none;
}

/* ── Options ── */
option {
  padding: 6px 10px;
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
}

option:hover,
option:focus {
  background: #e8f0fe;
}

option:checked {
  font-weight: 600;
}

/* ── Checkmark on selected option ── */
option::checkmark {
  margin-left: auto;
  color: #1a73e8;
}
</style>
