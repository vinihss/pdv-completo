#!/bin/sh
# dev-worktree.sh — convenção de trabalho em worktree, uma branch por diretório.
#
# POR QUE WORKTREE
# ----------------
# A regra do repo: o repositório é um clone bare em ~/pdv/.bare. Cada branch
# de trabalho tem seu próprio worktree DENTRO de ~/pdv/<branch>. O worktree de
# main fica em ~/pdv/main e serve só de base/coordenação (ler, comparar, abrir
# o editor). TODO desenvolvimento acontece no worktree da branch — o clone
# bare não tem working tree. Isso é o que permite ter a `main` sempre limpa
# enquanto se trabalha em uma branch — sem `git stash`, sem `git checkout`
# derrubando o trabalho alheio no meio, e sem o hook de pre-commit barrando
# commit porque o cwd está na main.
#
#   new <branch>   cria (ou reanexa) ~/pdv/<branch> a partir da
#                  origin/main recém-atualizada
#   list           lista os worktrees e a branch de cada um
#   rm <branch>    remove o worktree; a branch só é apagada se JÁ estiver
#                  mergeada na main
#   help           esta ajuda
#
# SEGURANÇA DO `rm`
# -----------------
# A branch nunca é apagada sem estar mergeada na `main`. Loss de trabalho por
# `git branch -D` já aconteceu neste repo — aqui o script recusa, e diz por
# quê, em vez de perguntar interativamente. Se a branch não estiver mergeada,
# o script APAGA o worktree mas PRESERVA a branch (o commit continua
# recuperável), e explica como removê-la de propósito depois.
set -eu

BASE_DIR="${PDV_WORKTREE_DIR:-$HOME/pdv}"
REMOTE_REF="origin/main"

usage() {
	cat <<EOF
Uso: $(basename "$0") <comando> [branch]

  new <branch>    Cria/reattacha o worktree em $BASE_DIR/<branch>,
                   a partir da $REMOTE_REF recém-atualizada.
  list            Lista os worktrees e a branch de cada um.
  rm <branch>     Remove o worktree. A branch só é apagada se já estiver
                   mergeada na main; nunca apaga trabalho não mergeado.
  help            Mostra esta ajuda.

Override do diretório: PDV_WORKTREE_DIR=/outro/caminho
EOF
}

die() {
	printf 'erro: %s\n' "$1" >&2
	exit 1
}

# Diretório do repositório principal (o que tem a main). Resolve pelo script,
# então funciona chamado de qualquer lugar — inclusive de dentro de um
# worktree de feature, que é o caso normal.
main_repo() {
	# O .git comum fica em <repo>/.git mesmo quando o cwd é um worktree ligado
	# (lá o .git é um arquivo, não um diretório). `dirname` dele é o repo.
	common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
	[ -n "$common" ] && dirname "$common"
}

cmd_new() {
	[ $# -eq 1 ] || { usage >&2; die "informe o nome da branch"; }
	branch="$1"
	# Branch com '/' é padrão no repo (fix/x, chore/x, ci/x) e vira subdiretório
	# em $BASE_DIR — inofensivo. Só o que poderia escapar de $BASE_DIR é barrado.
	case "$branch" in
		"") die "branch vazia" ;;
		-*) die "nome de branch inválido: $branch" ;;
		/*) die "branch não pode começar com '/': $branch" ;;
		..*|*/../*|*/..) die "branch não pode conter '..': $branch" ;;
	esac

	repo="$(main_repo)"
	[ -n "$repo" ] && [ -d "$repo" ] || die "não consegui localizar o repositório principal"
	target="$BASE_DIR/$branch"

	# Atualiza a referência de origem ANTES de criar a branch, para que a
	# branch nova já nasça com o que existe na origin/main em vez do que a
	# main local tinha quando alguém se lembrau de atualizar.
	( cd "$repo" && git fetch origin main )

	if [ -e "$target" ]; then
		# Diretório existe. Se já for worktree deste repo, reanexa.
		if [ -d "$target" ] && [ -f "$target/.git" ]; then
			printf 'worktree já existe em %s\n' "$target"
			( cd "$repo" && git worktree list )
			return 0
		fi
		die "$target existe e não é um worktree. Remova ou renomeie antes."
	fi

	if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
		# Branch já existe localmente: reanexa sem -b (não recria, não
		# descarta nada).
		git -C "$repo" worktree add "$target" "$branch"
		printf 'reattachado: %s -> %s\n' "$branch" "$target"
	else
		git -C "$repo" worktree add -b "$branch" "$target" "$REMOTE_REF"
		printf 'criado: %s -> %s (a partir de %s)\n' "$branch" "$target" "$REMOTE_REF"
	fi

	printf '\nPróximo passo:\n  cd %s\n' "$target"
}

cmd_list() {
	repo="$(main_repo)"
	cd "$repo"
	git worktree list
	printf '\n%s\n' "base: $BASE_DIR/<branch> (convenção deste repo)"
}

# A branch está na main?
#
# `git merge-base --is-ancestor` sozinho NÃO serve aqui, porque este repo mergeia
# por SQUASH: o squash cria um commit novo, então os commits da branch nunca viram
# ancestrais da main e o teste responde "não" para branch cujo PR já foi mergeado.
# Aconteceu com ci/pr-tests (PR #23), ci/instalador-so-quando-app-muda (#27),
# fix/modal-e-form-attribute (#25) e fix/outbox-lock-owner (#28): todas com PR
# MERGED, todas recusadas pelo `rm` como "NÃO está mergeada". O aviso estava certo
# no mecanismo e errado no resultado — a trava segurava trabalho já publicado na
# main, e o caminho de recuperação (`branch -D`) era o único jeito de limpar.
#
# Três sinais, do mais forte pro mais fraco; qualquer um basta:
#
#   1. ancestry direto — para commit que entrou como está (merge normal,
#      fast-forward, branch apontada para um commit já na main). Barato e sem
#      rede, então vai primeiro.
#   2. PR MERGED com esta head — cobre o squash. O `gh` é a fonte da verdade: é
#      onde o merge foi registrado.
#   3. patch-id presente na main — cobre o squash sem depender do `gh` (PR
#      fechado sem merge, `gh` fora do ar). Compara a DIFF, não o sha, então o
#      empacotamento em um commit só não importa. Só roda se a branch tiver
#      commits à frente da main: sem essa guarda ele casaria o diff de qualquer
#      commit já presente na main e devolveria "sim" sem provar nada.
#
# Sai "sim" ou "nao". Nunca "não" só porque o `gh` faltou ou a rede caiu: o (3)
# cobre esse caso sem rede.
branch_merged_in_main() {
	_repo="$1"
	_branch="$2"

	if git -C "$_repo" merge-base --is-ancestor "$_branch" "$REMOTE_REF" 2>/dev/null; then
		printf 'sim\n'
		return 0
	fi

	if command -v gh >/dev/null 2>&1; then
		_origin="$(git -C "$_repo" config --get remote.origin.url 2>/dev/null || true)"
		if [ -n "$_origin" ]; then
			_prs="$(gh pr list --repo "$_origin" --state merged \
				--head "$_branch" --json number --limit 1 2>/dev/null || true)"
			case "$_prs" in
			*'number'*)
				printf 'sim\n'
				return 0
				;;
			esac
		fi
	fi

	# Só há algo a procurar se a branch tiver commits que a main não tem.
	# Sem esta guarda o (3) dá "sim" para qualquer branch apontada para um
	# commit que já está na main (merge direto, rebase) — e o teste
	# real: feat/pagarme-multitenant tinha 0 commits à frente e casava com
	# um commit da main, o que não prova nada sobre o trabalho da branch.
	_ahead="$(git -C "$_repo" rev-list --count "$REMOTE_REF..$_branch" 2>/dev/null || printf '0')"
	[ "${_ahead:-0}" -gt 0 ] 2>/dev/null || { printf 'nao\n'; return 0; }

	_branch_head="$(git -C "$_repo" rev-parse "$_branch" 2>/dev/null || true)"
	[ -n "$_branch_head" ] || { printf 'nao\n'; return 0; }
	_pid="$(git -C "$_repo" show "$_branch_head" 2>/dev/null | git patch-id --stable | cut -d' ' -f1)"
	[ -n "$_pid" ] || { printf 'nao\n'; return 0; }
	if git -C "$_repo" log "$REMOTE_REF" --format=%H 2>/dev/null |
		while read -r _m; do
			_mpid="$(git -C "$_repo" show "$_m" 2>/dev/null | git patch-id --stable | cut -d' ' -f1)"
			[ "$_mpid" = "$_pid" ] && { printf 'sim\n'; exit 0; }
		done | grep -q '^sim$'; then
		printf 'sim\n'
		return 0
	fi

	printf 'nao\n'
}

cmd_rm() {
	[ $# -eq 1 ] || { usage >&2; die "informe o nome da branch"; }
	branch="$1"
	repo="$(main_repo)"
	# Onde a worktree DESTA branch está. Não assume `$BASE_DIR/$branch`: a
	# convenção vale para o que o `new` cria, mas um worktree já existente pode
	# estar em outro caminho — `ci-pr-workflow` apontava para `ci/pr-tests`, e o
	# `rm` procurava `~/pdv/feat/<branch>`, não achava, e o `branch -D`
	# seguinte falhava com "cannot delete branch ... used by worktree at ...".
	# Quem responde é o git, que registra a association branch -> worktree.
	target="$(git -C "$repo" worktree list --porcelain |
		awk -v b="refs/heads/$branch" '
			/^worktree /  { path = substr($0, 10) }
			$0 == "branch " b { print path; exit }
		')"
	[ -n "$target" ] || target="$BASE_DIR/$branch"

	# A branch precisa existir localmente para o passo de merge ser avaliável.
	if ! git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
		# Pode ser que o worktree exista mesmo assim (branch removida antes).
		if [ -d "$target" ] && [ -f "$target/.git" ]; then
			git -C "$repo" worktree remove --force "$target"
			printf 'removido: %s\n' "$target"
			return 0
		fi
		die "branch '$branch' não existe localmente"
	fi

	merged="$(branch_merged_in_main "$repo" "$branch")"

	if [ -d "$target" ] && [ -f "$target/.git" ]; then
		git -C "$repo" worktree remove --force "$target"
		printf 'removido: %s\n' "$target"
	fi

	if [ "$merged" = "sim" ]; then
		# `-D` e não `-d`: `branch -d` refaz a checagem de ancestry por baixo e
		# recusaria justamente a branch squash-mergeada que acabamos de confirmar.
		# A decisão já foi tomada acima; `-D` só executa.
		git -C "$repo" branch -D "$branch"
		printf 'branch apagada: %s (já estava mergeada na %s)\n' "$branch" "$REMOTE_REF"
	else
		printf '\n%s\n' "branch PRESERVADA: $branch"
		cat <<EOF
NÃO está mergeada na $REMOTE_REF, então não foi apagada — apagar trabalho
não mergeado já custou commits neste repo, e este script não faz isso.

O worktree saiu; a branch continua recuperável. Opções:
  ver o que ficou:            git log $REMOTE_REF..$branch
  publicar antes de apagar:   git push -u origin $branch && gh pr create --fill
  apagar de propósito:        git -C $repo branch -D $branch
EOF
	fi
}

[ $# -ge 1 ] || { usage >&2; exit 1; }

case "$1" in
	new) shift; cmd_new "$@" ;;
	list) shift; [ $# -eq 0 ] || die "list não recebe argumento"; cmd_list ;;
	rm) shift; cmd_rm "$@" ;;
	help | -h | --help) usage ;;
	*) usage >&2; die "comando desconhecido: $1" ;;
esac