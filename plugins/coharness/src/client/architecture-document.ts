// 浏览器在隔离文档内展示模型 HTML。策略禁止脚本和外部请求。
export function architectureDocument(html: string): string {
  const policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:20px;box-sizing:border-box;font-family:system-ui,sans-serif;color:#213d33;background:#fafcf8}*{box-sizing:border-box}svg{max-width:100%}details>summary{cursor:pointer}a{pointer-events:none}</style></head><body>${html}</body></html>`;
}

export function sanitizeArchitecture(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const allowed = new Set('html head body title style div section article header footer main aside nav h1 h2 h3 h4 h5 h6 p span strong em small b i code pre ul ol li dl dt dd table thead tbody tr th td details summary br hr svg g path rect circle ellipse line polyline polygon text tspan defs marker linearGradient radialGradient stop clipPath mask use'.toLowerCase().split(' '));
  for (const element of Array.from(parsed.querySelectorAll('*'))) {
    if (!allowed.has(element.tagName.toLowerCase())) { element.remove(); continue; }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || ['src','srcdoc','action','formaction','autofocus','is'].includes(name)
        || (name.endsWith('href') && !attribute.value.startsWith('#'))) element.removeAttribute(attribute.name);
    }
  }
  return parsed.documentElement.outerHTML;
}
