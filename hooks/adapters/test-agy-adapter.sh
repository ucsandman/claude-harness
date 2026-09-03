#!/bin/sh
# Self-check for agy-adapter.cjs. Run: sh ~/.claude/hooks/adapters/test-agy-adapter.sh
# Proves each guard both BLOCKS a real violation and PASSES a benign call under the
# agy payload dialect (harness rule L1: a check never seen failing is not verified).
A="$HOME/.claude/hooks/adapters/agy-adapter.cjs"
H="$HOME/.claude/hooks"
fails=0

# Assembled at runtime so no key-shaped literal is ever stored in this file
# (secret-guard blocks writing one, correctly).
FAKEKEY="sk-ant-api03-$(printf 'A%.0s' $(seq 1 88))-$(printf 'A%.0s' $(seq 1 8))"

check() { # name  expect(deny|pass)  event  guard  payload-json
  name=$1; expect=$2; ev=$3; guard=$4; payload=$5
  out=$(printf '%s' "$payload" | node "$A" "$ev" node "$guard" 2>/dev/null)
  case "$out" in
    *'"decision":"deny"'*) got=deny ;;
    *) got=pass ;;
  esac
  if [ "$got" = "$expect" ]; then
    printf 'PASS  %-34s -> %s\n' "$name" "$got"
  else
    printf 'FAIL  %-34s expected=%s got=%s  raw=%s\n' "$name" "$expect" "$got" "$out"
    fails=$((fails+1))
  fi
}

W='{"conversationId":"c1","workspacePaths":["C:/Projects"],"modelName":"auto","stepIdx":3,"toolCall":'
KILL="$W"'{"name":"run_command","args":{"CommandLine":"taskkill /IM node.exe"}}}'
KILL_OK="$W"'{"name":"run_command","args":{"CommandLine":"taskkill /F /PID 1234"}}}'
GITADD="$W"'{"name":"run_command","args":{"CommandLine":"git add .env"}}}'
BENIGN="$W"'{"name":"run_command","args":{"CommandLine":"git status"}}}'
LEAK="$W"'{"name":"write_to_file","args":{"TargetFile":"C:/Projects/x/n.md","CodeContent":"'"$FAKEKEY"'"}}}'
CLEAN="$W"'{"name":"write_to_file","args":{"TargetFile":"C:/Projects/x/n.md","CodeContent":"just some prose"}}}'
GARBAGE='not json at all'

check "kill-guard/name-based-kill"   deny PreToolUse "$H/process-kill-guard.cjs" "$KILL"
check "kill-guard/pid-based-kill"    pass PreToolUse "$H/process-kill-guard.cjs" "$KILL_OK"
check "secret-guard/git-add-dotenv"  deny PreToolUse "$H/secret-guard.cjs"       "$GITADD"
check "secret-guard/api-key-write"   deny PreToolUse "$H/secret-guard.cjs"       "$LEAK"
check "secret-guard/clean-write"     pass PreToolUse "$H/secret-guard.cjs"       "$CLEAN"
check "secret-guard/benign-command"  pass PreToolUse "$H/secret-guard.cjs"       "$BENIGN"
check "adapter/unparseable-payload"  pass PreToolUse "$H/secret-guard.cjs"       "$GARBAGE"
check "adapter/missing-guard"        pass PreToolUse "$H/does-not-exist.cjs"     "$KILL"

echo
# --- chain mode ---------------------------------------------------------------
# agy merges multiple hooks per event and the LAST reason wins, so guards must be
# chained into ONE entry. These prove the chain denies with the reason intact.
CHAIN="node $H/secret-guard.cjs ++ node $H/process-kill-guard.cjs ++ node $H/dev-server-guard.cjs ++ node $H/scope-lock.cjs ++ rtk hook claude"
chain_out() { printf '%s' "$1" | node "$A" PreToolUse $CHAIN 2>/dev/null; }

o=$(chain_out "$KILL")
case "$o" in *'"decision":"deny"'*) d=ok;; *) d=bad;; esac
case "$o" in *'process-kill-guard'*) r=ok;; *) r=bad;; esac
[ "$d" = ok ] && printf 'PASS  %-34s -> deny\n' "chain/kill-denies" || { printf 'FAIL  chain/kill-denies  %s\n' "$o"; fails=$((fails+1)); }
[ "$r" = ok ] && printf 'PASS  %-34s -> reason present\n' "chain/kill-reason-survives" || { printf 'FAIL  chain/kill-reason-survives  %s\n' "$o"; fails=$((fails+1)); }

o=$(chain_out "$GITADD")
case "$o" in *'"decision":"deny"'*) printf 'PASS  %-34s -> deny\n' "chain/gitadd-denies";; *) printf 'FAIL  chain/gitadd-denies  %s\n' "$o"; fails=$((fails+1));; esac

# benign command: no deny, and rtk's rewrite must survive to the end of the chain
o=$(chain_out "$BENIGN")
case "$o" in
  *'"decision":"deny"'*) printf 'FAIL  chain/benign-not-denied  %s\n' "$o"; fails=$((fails+1));;
  *'"overwrite"'*'rtk git status'*) printf 'PASS  %-34s -> rtk rewrite kept\n' "chain/benign-rtk-rewrite";;
  *) printf 'FAIL  chain/benign-rtk-rewrite  %s\n' "$o"; fails=$((fails+1));;
esac

echo
[ "$fails" -eq 0 ] && echo "all checks passed" || { echo "$fails check(s) FAILED"; exit 1; }
