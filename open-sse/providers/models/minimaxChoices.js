// Ordinary choices only. Never use this to validate or rewrite an explicit model ID.
// Gateway IDs must already come from that gateway's registry or fetched catalog.
export function currentMiniMaxChoices(models) {
  const isText = (model) => (!model.kind || model.kind === "llm")
    && (!model.type || model.type === "llm")
    && /(?:^|\/)minimax-(?:m\d|text-\d|vl-\d|01)/i.test(model.id);
  const current = models.filter((model) => !isText(model)
    || /(?:^|\/)minimax-m3(?:\.1-flash)?(?::free|-free)?$/i.test(model.id));
  const miniMax = current.filter(isText).sort((a, b) =>
    Number(/m3\.1-flash/i.test(b.id)) - Number(/m3\.1-flash/i.test(a.id)));
  let index = 0;
  return current.map((model) => isText(model) ? miniMax[index++] : model);
}
