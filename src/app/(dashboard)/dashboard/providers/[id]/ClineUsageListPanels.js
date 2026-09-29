"use client";
import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Button, Modal } from "@/shared/components";
import { translate } from "@/i18n/runtime";

const PAGE_SIZE = 100;
const TABS = [["free", "免费"], ["paid", "付费"]];

// Cline's live catalog (464 ids) is served by default and the custom-models API
// can't delete catalog rows, so "unselected = not served" is enforced by the
// disabled list. The usage list here is the user-facing truth: the page renders
// selected ids only, and every save recomputes the hidden set as
// catalog − selected.
export default function ClineUsageListPanels({ freeIds, selectedIds, busy, onRefresh, onSave, renderRow }) {
  const [tab, setTab] = useState("free");
  const [picker, setPicker] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const inBucket = (bucket, id) => (bucket === "free" ? freeIds.has(id) : !freeIds.has(id));
  const rows = selectedIds.filter((id) => inBucket(tab, id));
  const count = (bucket) => selectedIds.filter((id) => inBucket(bucket, id)).length;

  const openPicker = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const candidates = (await onRefresh(tab)) || [];
      if (candidates.length === 0) return;
      setPicker({
        bucket: tab,
        candidates,
        checked: selectedIds.filter((id) => inBucket(tab, id)),
        seq: (picker?.seq ?? 0) + 1,
      });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
              tab === key
                ? "border-primary bg-primary/5 text-primary"
                : "border-black/10 text-text-muted hover:border-primary/40 hover:text-primary dark:border-white/10"
            }`}
          >
            {translate(label)} ({count(key)})
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={openPicker}
          disabled={refreshing || busy}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-primary/40 px-3 py-2 text-xs text-primary transition-colors hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
        >
          <span
            className="material-symbols-outlined text-sm"
            style={refreshing ? { animation: "spin 1s linear infinite" } : undefined}
          >
            {refreshing ? "progress_activity" : "sync"}
          </span>
          {refreshing ? translate("Fetching...") : translate("Refresh")}
        </button>

        {rows.map((id) => renderRow(id))}

        {rows.length === 0 && (
          <p className="text-xs text-text-muted">
            {translate("No models selected yet. Use Refresh to pick from the catalog.")}
          </p>
        )}
      </div>

      {picker && (
        <ClineUsageListPicker
          key={picker.seq}
          picker={picker}
          busy={busy}
          onClose={() => setPicker(null)}
          onSave={(ids) => {
            setPicker(null);
            onSave(picker.bucket, ids);
          }}
        />
      )}
    </div>
  );
}

function ClineUsageListPicker({ picker, busy, onClose, onSave }) {
  const [checked, setChecked] = useState(() => new Set(picker.checked));
  const [search, setSearch] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [dirty, setDirty] = useState(false);

  // Paging must follow the search: without this, clearing the box after paging
  // deep renders every loaded row back into a short list.
  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [search]);

  const needle = search.trim().toLowerCase();
  const candidates = picker.candidates.filter(
    (id) => !checked.has(id) && (!needle || id.toLowerCase().includes(needle))
  );
  const selected = [...checked];

  const toggle = (id) => {
    setDirty(true);
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Modal
      isOpen
      // Esc/Cancel would silently drop every edit; make leaving explicit.
      onClose={() => {
        if (dirty && !window.confirm(translate("Discard unsaved selection?"))) return;
        onClose();
      }}
      title={translate("Model usage list")}
      size="2xl"
      closeOnOverlay={false}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-xs text-text-muted">
            {translate("Selected")} {selected.length} / {picker.candidates.length}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => {
              if (dirty && !window.confirm(translate("Discard unsaved selection?"))) return;
              onClose();
            }}>
              {translate("Cancel")}
            </Button>
            <Button onClick={() => onSave(selected)} disabled={!dirty || busy}>
              {translate("Save")}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <input
          type="text"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={translate("Search models")}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex min-h-0 flex-col gap-1">
            <p className="text-xs font-medium text-text-muted">
              {translate("Usage list")} ({selected.length})
            </p>
            <div className="flex max-h-[55vh] flex-col gap-1 overflow-y-auto">
              {selected.length === 0 && (
                <p className="text-xs text-text-muted">{translate("Nothing selected")}</p>
              )}
              {selected.map((id) => (
                <PickerRow key={id} id={id} checked onToggle={toggle} />
              ))}
            </div>
          </div>
          <div className="flex min-h-0 flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-text-muted">
                {translate("Candidates")} ({candidates.length})
              </p>
              {candidates.length > 0 && (
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setDirty(true);
                      setChecked((prev) => new Set([...prev, ...candidates]));
                    }}
                    className="rounded px-1.5 py-0.5 text-xs text-primary hover:bg-primary/10"
                  >
                    {translate("Select all")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDirty(true);
                      setChecked((prev) => {
                        const next = new Set(prev);
                        candidates.forEach((id) => next.delete(id));
                        return next;
                      });
                    }}
                    className="rounded px-1.5 py-0.5 text-xs text-text-muted hover:text-primary"
                  >
                    {translate("Clear")}
                  </button>
                </div>
              )}
            </div>
            <div className="flex max-h-[55vh] flex-col gap-1 overflow-y-auto">
              {candidates.length === 0 && (
                <p className="text-xs text-text-muted">
                  {needle ? translate(`No models match "${search.trim()}"`) : translate("All models selected")}
                </p>
              )}
              {candidates.slice(0, visible).map((id) => (
                <PickerRow key={id} id={id} onToggle={toggle} />
              ))}
              {candidates.length > visible && (
                <button
                  type="button"
                  onClick={() => setVisible((n) => n + PAGE_SIZE)}
                  className="rounded-lg border border-dashed border-black/10 px-2 py-1 text-xs text-text-muted hover:border-primary hover:text-primary dark:border-white/10"
                >
                  {translate("Load more")} ({candidates.length - visible})
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function PickerRow({ id, checked, onToggle }) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1 transition-colors ${
        checked ? "border-primary/40 bg-primary/5" : "border-border hover:border-primary/40"
      }`}
    >
      <input
        type="checkbox"
        checked={!!checked}
        onChange={() => onToggle(id)}
        aria-label={id}
        title={id}
        className="h-3.5 w-3.5 shrink-0 rounded border-gray-300 text-primary focus:ring-primary"
      />
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={id}>
        {id}
      </code>
    </label>
  );
}

PickerRow.propTypes = {
  id: PropTypes.string.isRequired,
  checked: PropTypes.bool,
  onToggle: PropTypes.func.isRequired,
};

ClineUsageListPanels.propTypes = {
  freeIds: PropTypes.object.isRequired,
  selectedIds: PropTypes.arrayOf(PropTypes.string).isRequired,
  busy: PropTypes.bool,
  onRefresh: PropTypes.func.isRequired,
  onSave: PropTypes.func.isRequired,
  renderRow: PropTypes.func.isRequired,
};
