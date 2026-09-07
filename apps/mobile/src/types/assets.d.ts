declare module "*.css";
declare module "*.html" {
  const assetModuleId: number;
  export default assetModuleId;
}
