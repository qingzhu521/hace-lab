declare module '*.module.css' { const classes: Record<string, string>; export default classes; }
declare module '*.css?inline' { const css: string; export default css; }

declare module '*?workbench' { const html: string; export default html; }
