import "./ModelSelector.css";

const MODELS = [
  { value: "auto", label: "Auto", desc: "Smart routing" },
  { value: "ilmu", label: "ILMU", desc: "Fast BM chat" },
  { value: "deepseek", label: "DeepSeek", desc: "Deep reasoning" },
];

export default function ModelSelector({ model, onChange }) {
  return (
    <select
      className="model-selector"
      value={model}
      onChange={(e) => onChange(e.target.value)}
      title="Select AI model"
    >
      {MODELS.map((m) => (
        <option key={m.value} value={m.value}>
          {m.label}
        </option>
      ))}
    </select>
  );
}
