/* 页面左上角和标签页使用的实例品牌名：副实例加 co- 前缀，便于和主实例区分。
   角色未知（接口失败）时按主实例显示。 */
export function instanceBrand(role: "primary" | "secondary" | null): string {
  return role === "secondary" ? "co-Qubius" : "Qubius";
}
