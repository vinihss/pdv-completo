#!/bin/sh
# dev-worktree.sh — convenção de trabalho em worktree, uma branch por diretório.
#
# POR QUE WORKTREE
# ----------------
# A regra do repo: o worktree principal (~/pdv-completo) fica em `main` e serve
# só de base/coordenação. TODO desenvolvimento acontece em worktree separado
# em ~/pdv-worktrees/<branch>. Isso é o que permite ter a `main` sempre
# checkada e limpa (para ler, comparar, abrir o editor) enquanto se trabalha em
# uma branch — sem `git stash`, sem `git checkout` derrubando o trabalho alheio
# no meio, e sem o hook de pre-commit barrando commit porque o cwd está na
# main.
#
# Por que o diretório é IRMÃO do repo e não dentro dele: o git recusa
# `git worktree add` para um caminho dentro de outro repositório/working tree.
#
#   new <branch>   cria (ou reanexa) ~/pdv-worktrees/<branch> a partir da
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

BASE_DIR="${PDV_WORKTREE_DIR:-$HOME/pdv-worktrees}"
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

cmd_rm() {
	[ $# -eq 1 ] || { usage >&2; die "informe o nome da branch"; }
	branch="$1"
	repo="$(main_repo)"
	target="$BASE_DIR/$branch"

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

	# Trava de segurança: só apaga branch já contida na main. `git branch -d`
	# faria essa checagem sozinho, mas avaliamos aqui para poder explicar e
	# para decidir entre "remove worktree e preserva branch" e "recusa tudo".
	if git -C "$repo" merge-base --is-ancestor "$branch" "$REMOTE_REF"; then
		merged="sim"
	else
		merged="nao"
	fi

	if [ -d "$target" ] && [ -f "$target/.git" ]; then
		git -C "$repo" worktree remove --force "$target"
		printf 'removido: %s\n' "$target"
	fi

	if [ "$merged" = "sim" ]; then
		git -C "$repo" branch -d "$branch"
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