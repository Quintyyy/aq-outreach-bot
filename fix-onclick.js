const fs = require('fs');
let html = fs.readFileSync('dashboard.html', 'utf8');

// Add a JS-safe escape function
const jsEscFunc = `
function jsEsc(s) {
  return String(s || '').replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'").replace(/"/g,'\\\\"');
}
`;

// Insert jsEsc function right after the esc function
html = html.replace(
  /function esc\(s\) \{[\s\S]*?return String[\s\S]*?\}/,
  match => match + '\n' + jsEscFunc
);

// Fix callOne onclick in renderTable
html = html.replace(
  /onclick="callOne\('\$\{p\.id\}','\$\{esc\(phone\)\}','\$\{esc\(displayName\)\}'\)"/g,
  `onclick="callOne('\${p.id}','\${jsEsc(phone)}','\${jsEsc(displayName)}')"` 
);

// Fix retryCall onclick
html = html.replace(
  /onclick="retryCall\('\$\{p\.id\}','\$\{esc\(phone\)\}','\$\{esc\(displayName\)\}'\)"/g,
  `onclick="retryCall('\${p.id}','\${jsEsc(phone)}','\${jsEsc(displayName)}')"` 
);

// Fix showHistory onclick
html = html.replace(
  /onclick="showHistory\('\$\{p\.id\}','\$\{esc\(displayName\)\}'\)"/g,
  `onclick="showHistory('\${p.id}','\${jsEsc(displayName)}')"` 
);

fs.writeFileSync('dashboard.html', html);
console.log('Fixed! onclick handlers now use jsEsc() instead of esc()');
