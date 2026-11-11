/**
 * Entrada escondida do administrador da plataforma: /adm.
 *
 * Não há link visível pra cá em lugar nenhum do site — só quem conhece
 * o endereço chega. Renderiza o mesmo app da página principal; o boot
 * detecta o caminho e abre o login do administrador (primeiro acesso
 * cria o login dele; com sessão válida, abre o painel direto, com os
 * restaurantes, os planos e o período grátis de cada um).
 */
import Page from '../page';

export default function AdminPage() {
  return <Page />;
}
