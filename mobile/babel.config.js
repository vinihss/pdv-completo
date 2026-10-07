// Babel do Metro. `APP_VARIANT` é inline no JS em tempo de BUILD: cada loja
// recebe um apk com a variante fixa e o codebase roda nunca lendo ambiente em
// runtime (mesma razão de app.config.js). O plugin usado é o
// `babel-plugin-transform-inline-environment-variables` (o nome
// `@babel/plugin-transform-inline-environment-variables` não existe no
// registry). O cache do Metro PRECISA saber da variante: sem o
// `api.cache.invalidate`, trocar `start:garcon`/`start:entregador` com o
// Metro quente continuaria servindo o bundle do build anterior.
module.exports = function (api) {
  api.cache.invalidate(() => process.env.APP_VARIANT ?? "");
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      [
        "babel-plugin-transform-inline-environment-variables",
        { include: ["APP_VARIANT"] },
      ],
    ],
  };
};