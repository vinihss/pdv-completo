export { NavProvider, useNav } from "./NavProvider.jsx";
// `allItems` e `sectionOwning` entram na lista porque o menu tem três níveis
// agora: quem valida o id guardado e quem monta o mapa de telas precisam
// enxergar os itens de submenu, e cada um fazendo a busca por conta própria é
// como o submenu aparece num lugar e some no outro.
export { menuSectionsFor, hasExpandableSections, firstItemId, allItems, sectionOwning } from "./menuSections.js";
