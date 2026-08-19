import { parseUnifiedDiff } from "../../../core/index.js";

export function UnifiedDiffView({ patch }: { patch: string }) {
  if (!patch) {
    return <p className="diff-binary-message">无 diff 内容。</p>;
  }
  const lines = parseUnifiedDiff(patch);
  return (
    <table className="diff-patch" aria-label="代码 diff，左侧依次显示旧行号和新行号">
      <tbody>
        {lines.map((line, index) => (
          <tr key={index} className={"diff-line diff-line-" + line.kind}>
            <td className="diff-line-number diff-line-number-old" aria-hidden="true">
              {line.oldLineNumber ?? ""}
            </td>
            <td className="diff-line-number diff-line-number-new" aria-hidden="true">
              {line.newLineNumber ?? ""}
            </td>
            <td className="diff-line-content">{line.text || " "}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
