// Impede a janela de console extra no Windows em release. O comentário é o do
// app v1 e continua valendo, mas aqui é menos crítico: o alvo principal é
// mobile, e o Windows é só o caminho que o `cargo check` do host compila.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  pdv_garcon_lib::run();
}
