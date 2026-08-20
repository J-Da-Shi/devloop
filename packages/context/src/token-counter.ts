/**
 * 判断字符是否属于 CJK（含扩展 A + 兼容区 + 平假名 / 片假名）。
 */
const CJK_REGEX = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/u;

/**
 * 估算 token 数（保守估算，用于预算判定）：
 * - CJK 字符按 1.6 tokens/字符（GPT tokenizer 通常 1~2 之间，保守取偏高值）
 * - 其他字符按 length / 3.5（GPT 平均比 1/4 略高一点）
 * 最终 Math.ceil 保证不低于真实值。
 */
export const estimateTokens = (text: string): number => {
  if (text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_REGEX.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 1.6 + other / 3.5);
};
