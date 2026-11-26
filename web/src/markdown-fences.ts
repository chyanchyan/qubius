/**
 * 围栏代码块的渲染判定。
 *
 * 会话里 agent 经常把整段文档塞进围栏：最常见的是 ```markdown，但也常见的是
 * 模型围栏错位——先用自己的 ``` 提前闭合 markdown 围栏，之后又用一个没有语言的
 * 围栏包住文档后半段。CommonMark 只认“没有 info string 的 ```”作闭合，于是后面
 * 的正文会整段被当成代码。这里用保守的启发式把“明显是文档”的无语言围栏也按
 * Markdown 渲染，避免正文变成一大块代码。
 */

/** 围栏最终怎么渲染：按 Markdown 文档、按代码，或者整块隐藏（游离围栏留下的空块）。 */
export type FenceKind = "markdown" | "code" | "hidden";

const MARKDOWN_LANGUAGES = new Set(["markdown", "md"]);

/* 块级 Markdown 结构。至少要命中两种互相独立的维度才认为“这是一篇文档”。 */
const HEADING = /^ {0,3}(#{1,6})[ \t]+\S/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BLOCKQUOTE = /^ {0,3}>/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+\S/;
const TABLE_DIVIDER =
  /^ {0,3}\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/;

/* 强代码特征：命中任意一行就按代码处理，避免把带 # 注释的脚本误判成文档。 */
const CODE_LINE =
  /^ {0,3}(?:def |class |import |from \S+ import |const |let |var |function |func |fn |package |using |#include|SELECT\b|INSERT\b|UPDATE\b|DELETE\b|CREATE\b|ALTER\b)|\b=>|\)\s*\{\s*$|;\s*$/;

/** ```markdown / ```md（大小写、首尾空白都不敏感）。 */
export function isMarkdownFenceLanguage(language: string): boolean {
  return MARKDOWN_LANGUAGES.has(language.trim().toLowerCase());
}

/**
 * 无语言围栏的内容是否明显是一篇 Markdown 文档。
 *
 * 判定要求至少两种互相独立的块级结构（例如标题 + 列表、分隔线 + 引用），
 * 并且其中必须有标题/引用/表格这类文档特征；只有列表、只有分隔线（YAML 的
 * `---`）或只有注释行都会保持代码。命中强代码特征的行直接判为代码。
 */
export function looksLikeMarkdownDocument(text: string): boolean {
  const dims = new Set<string>();
  let codeish = false;

  for (const line of text.split("\n")) {
    if (CODE_LINE.test(line)) {
      codeish = true;
      break;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      /* 标题层级各算一维：# 和 ## 同时出现通常是文档，而不是单层 # 注释。 */
      dims.add(`h${heading[1].length}`);
      continue;
    }
    if (THEMATIC_BREAK.test(line)) dims.add("rule");
    else if (BLOCKQUOTE.test(line)) dims.add("quote");
    else if (TABLE_DIVIDER.test(line)) dims.add("table");
    else if (LIST_ITEM.test(line)) dims.add("list");
  }

  if (codeish || dims.size < 2) return false;
  for (const dim of dims) {
    if (dim !== "list" && dim !== "rule") return true;
  }
  return false;
}

/** 根据围栏语言和内容决定渲染方式。 */
export function fenceKind(language: string, code: string): FenceKind {
  const lang = language.trim().toLowerCase();
  if (isMarkdownFenceLanguage(lang)) {
    /* 语言标记明确，即使内容为空也按空文档处理，不额外特殊化。 */
    return "markdown";
  }
  if (lang === "" && code.trim() === "") {
    /* 围栏错位后常留下一个没有内容的无语言围栏，渲染出来只是一个空框。 */
    return "hidden";
  }
  if (lang === "" && looksLikeMarkdownDocument(code)) return "markdown";
  return "code";
}
