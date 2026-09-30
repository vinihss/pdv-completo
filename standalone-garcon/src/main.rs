// Impede a janela de console extra no Windows em release. Em mobile não aplica.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  pdv_garcon_lib::run();
}
