const palette = (id, name, description, values, light = false) => {
  const keys = ['bg', 'sidebar', 'panel', 'input', 'hover', 'line', 'text', 'muted', 'subtle', 'accent', 'selected', 'selection-line', 'amber', 'thumb'];
  const colors = Object.fromEntries(keys.map((key, index) => [key, values[index]]));
  Object.assign(colors, light ? { 'accent-ink': '#ffffff', claude: '#9b4b2e', codex: '#6453a4', ssh: '#286789', banner: '#f7ecd3', 'banner-text': '#785514', error: '#a83535', 'error-bg': '#fbe9e5' } : { 'accent-ink': '#14201e', claude: '#e1af93', codex: '#c6b5e9', ssh: '#9cbfe4', banner: colors.panel, 'banner-text': colors.amber, error: '#efaca1', 'error-bg': '#432e30' });
  return { id, name, description, colors, light };
};
export const themes = [
  palette('harbor', 'Harbor', 'Графит и мята', ['#151719','#191b1e','#202326','#16181b','#2a3030','#353c3f','#e6e8e8','#a4afb3','#8a969c','#8fd1ba','#293b34','#577a68','#dfbb80','#596963']),
  palette('midnight', 'Midnight', 'Глубокий синий', ['#101725','#141e30','#1c2940','#101a2b','#273750','#33455f','#e2eaf7','#a4b7d2','#91a5c1','#8cbaff','#243d5d','#5479aa','#edc88f','#57769c']),
  palette('nord', 'Nord', 'Холодные спокойные тона', ['#2e3440','#292f3a','#363e4c','#292f3a','#414c5c','#4c596c','#eceff4','#bdc9d9','#a3b1c5','#88c0d0','#3c5260','#638b9b','#ebcb8b','#738b9b']),
  palette('plum', 'Plum', 'Фиолетовый и лаванда', ['#221d2c','#292231','#31293e','#211a2c','#3e3350','#4f4160','#efe7f7','#c0b0d0','#ad9abb','#c6a0ef','#403451','#81669b','#edc48d','#806b95']),
  palette('forest', 'Forest', 'Тёплый зелёный', ['#17221d','#1c2922','#24352b','#17251d','#304538','#40594a','#e4ece2','#a9bfae','#94ae9b','#a5d393','#304a35','#668b62','#e2c18c','#668b70']),
  palette('paper', 'Paper', 'Светлая бумага', ['#faf9f6','#eeede8','#ffffff','#ffffff','#e6e9e2','#d1d5cd','#27352f','#53665d','#64766c','#287052','#dcebe1','#7ca68c','#835b19','#84998d'], true),
];
export function terminalTheme(theme) {
  const c = theme.colors;
  const ansi = theme.light
    ? ['#37433d','#ad3839','#376d3e','#866014','#315e9e','#7951a3','#256d76','#686f6b','#69776e','#bd4341','#377b42','#8f6818','#3d6ab5','#8a56ad','#297e86','#27352f']
    : ['#30383c','#e59189','#9bd3a7','#dfc38b','#93b5dc','#c2a5d5','#8bc8c7','#d4dad7','#8b969a','#f0aaa3','#b0e5b7','#ecd49e','#abcaf0','#d9bde9','#a7e0dd','#f1f5f2'];
  const names = ['black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'];
  return { ...Object.fromEntries(names.map((key, index) => [key, ansi[index]])), background: c.bg, foreground: c.text, cursor: c.accent, cursorAccent: c.bg, selectionBackground: c['selection-line'] + '70', selectionInactiveBackground: c['selection-line'] + '45' };
}
