// Impede a janela de console extra no Windows em release. O comentário é o do
// app v1 e continua valendo, mas aqui dói mais: o KDS abre em `fullscreen`,
// então um terminal preto por cima da tela de parede é exatamente o defeito
// que o gerente ia ver na primeira instalação.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  pdv_kds_lib::run();
}
