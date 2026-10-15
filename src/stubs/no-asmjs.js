// asm.js build of Clipper is never used (WebAssembly or pure-JS Clipper2 instead).
module.exports = function () { return Promise.reject(new Error('asm.js build not bundled')); };
