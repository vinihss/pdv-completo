// Impede a janela de console extra no Windows em release. O comentário é o do
// app v1 e continua valendo, mas aqui é menos crítico: o entregador é mobile,
// e este binário desktop só existe para o `cargo check` do host compilar o
// caminho desktop. Ainda assim, se alguém rodar `cargo run` aqui, sem esta
// linha um terminal preto abre junto com a janela.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  pdv_entregador_lib::run();
}
