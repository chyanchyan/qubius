/** 表单字段旁的问号提示：悬停或聚焦显示说明，不触发外层 label 的点击行为。 */
export function Hint({ text }: { text: string }) {
  return (
    <span
      className="field-hint"
      tabIndex={0}
      role="img"
      aria-label={text}
      title={text}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <span className="field-hint-icon" aria-hidden="true">?</span>
      <span className="field-hint-tip" role="tooltip">{text}</span>
    </span>
  );
}
