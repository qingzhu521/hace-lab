import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

await mkdir('lib', { recursive: true });
const styleMarker = '__COHARNESS_COMPILED_CSS__';
const cssModulePlugin = {
  name: 'coharness-css', setup(builder) {
    builder.onResolve({ filter: /\.css\?inline$/ }, () => ({ path: 'style', namespace: 'coharness' }));
    builder.onLoad({ filter: /.*/, namespace: 'coharness' }, () => ({ contents: `export default ${JSON.stringify(styleMarker)}`, loader: 'js' }));
  },
};
await build({ entryPoints: ['src/index.ts'], outfile: 'lib/index.js', bundle: true, format: 'esm', platform: 'node', packages: 'external' });
const editorBundle = await build({entryPoints:['src/client/workbench/editor.ts'],bundle:true,format:'iife',platform:'browser',write:false});
const workbenchPlugin = { name: 'coharness-workbench', setup(builder) {
  builder.onResolve({filter:/\?workbench$/}, () => ({path:'workbench',namespace:'workbench'}));
  builder.onLoad({filter:/.*/,namespace:'workbench'}, async () => {
    const base='src/client/workbench/';
    let html=await readFile(base+'index.html','utf8');
    const css=await readFile(base+'style.css','utf8');
    const sources=await Promise.all(['bridge.js','spaces.js','reading.js','workflow.js','app.js','editor-layout.js'].map(name=>readFile(base+name,'utf8')));
    const code=(editorBundle.outputFiles[0].text+'\n'+sources.join('\n')).replace(/<\/script/gi,'<\\/script');
    html=html.replace(/<link[^>]+>/g,'').replace(/<script[\s\S]*?<\/script>/g,'');
    html=html.replace('</head>',()=>'<style>'+css+'</style></head>').replace('</body>',()=>'<script>'+code+'</script></body>');
    return {contents:html,loader:'text'};
  });
}};
const client = await build({
  entryPoints: ['src/client/index.ts'], outfile: 'lib/client.js', bundle: true,
  format: 'cjs', platform: 'browser', jsx: 'automatic', write: false,
  external: ['react', 'react/*', '@deepseek-ai/*'],
  plugins: [cssModulePlugin, workbenchPlugin],
  banner: { js: 'window.__ModuleLoader__.load({id:"coharness-dsh",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
});
const css = client.outputFiles.find(file => file.path.endsWith('.css'));
const js = client.outputFiles.find(file => file.path.endsWith('.js'));
if (!css || !js) throw new Error('Client build must emit JavaScript and CSS');
await writeFile('lib/client.js', js.text.replace(JSON.stringify(styleMarker), () => JSON.stringify(css.text)));
