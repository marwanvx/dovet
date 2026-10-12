#!/bin/sh
# Installs Dovet: curl -fsSL <url>/install.sh | sh   (cli-config "Install, PATH and uninstall"; architecture "Distribution")
# Test hooks: DOVET_BASE_URL (release assets), DOVET_RELEASE_PUBLIC_KEYS (comma-separated), DOVET_INSTALL_DIR, DOVET_BIN_DIR.
set -eu

DOVET_EMBEDDED_KEYS=""
DOVET_LATEST_URL="https://github.com/marwanvx/dovet/releases/latest/download"

die() {
  echo "dovet install: $*" >&2
  exit 1
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1" || die "downloading $1 failed"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1" || die "downloading $1 failed"
  else
    die "curl or wget is required"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

host_target() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) die "no Dovet release for $(uname -s); on Windows use install.ps1" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "no Dovet release for $(uname -m)" ;;
  esac
  # A shell running under Rosetta reports x86_64 on an Apple Silicon Mac.
  if [ "$os" = darwin ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
  musl=
  if [ "$os" = linux ]; then
    set -- /lib/ld-musl-*
    if [ -e "$1" ]; then musl=-musl; fi
  fi
  echo "$os-$arch$musl"
}

# Ed25519 needs OpenSSL 3 (macOS's LibreSSL can't verify a raw signature), so each candidate proves itself on RFC 8032 test 2.
find_openssl() {
  tmp_t=$1
  printf 'PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=' >"$tmp_t/t.key"
  printf 'kqAJqfDUyrhyDoILX2QlQKKye1QWUD+Ps3YiI+vbadoIWsHkPhWZbkWPNhPQ8R2MOHsurrQwKu6wDSkWErsMAA==' >"$tmp_t/t.sig"
  printf r >"$tmp_t/t.msg"
  for candidate in openssl /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    write_pem "$(cat "$tmp_t/t.key")" "$tmp_t/t.pem"
    "$candidate" base64 -d -A -in "$tmp_t/t.sig" -out "$tmp_t/t.sigbin" 2>/dev/null || continue
    if "$candidate" pkeyutl -verify -pubin -inkey "$tmp_t/t.pem" -rawin -in "$tmp_t/t.msg" -sigfile "$tmp_t/t.sigbin" >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

# The fixed prefix is the Ed25519 SubjectPublicKeyInfo header (12 bytes), so its base64 joins the key's base64 as is.
write_pem() {
  printf -- '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA%s\n-----END PUBLIC KEY-----\n' "$1" >"$2"
}

verify_signature() {
  keys=${DOVET_RELEASE_PUBLIC_KEYS:-$DOVET_EMBEDDED_KEYS}
  [ -n "$keys" ] || die "this install script has no release key yet, so it can't verify a download"
  ssl=$(find_openssl "$1") || die "verifying the signature needs OpenSSL 3 (on macOS: brew install openssl)"
  for key in $(printf '%s' "$keys" | tr ',' ' '); do
    write_pem "$key" "$1/key.pem"
    if "$ssl" pkeyutl -verify -pubin -inkey "$1/key.pem" -rawin -in "$1/SHA256SUMS" -sigfile "$1/SHA256SUMS.sig" >/dev/null 2>&1; then
      return 0
    fi
  done
  die "the SHA256SUMS signature does not verify against any trusted release key"
}

main() {
  target=$(host_target)
  base=${DOVET_BASE_URL:-$DOVET_LATEST_URL}
  root=${DOVET_INSTALL_DIR:-$HOME/.local/share/dovet}
  bindir=${DOVET_BIN_DIR:-$HOME/.local/bin}

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/dovet-install.XXXXXX")
  scratch=
  trap 'rm -rf "$tmp" ${scratch:+"$scratch"}' EXIT

  fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS"
  fetch "$base/SHA256SUMS.sig" "$tmp/SHA256SUMS.sig"
  verify_signature "$tmp"

  line=$(grep -E "^[0-9a-f]{64}  dovet-[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?-$target\.tar\.gz\$" "$tmp/SHA256SUMS" || true)
  [ -n "$line" ] || die "the latest release has no archive for $target"
  [ "$(echo "$line" | wc -l)" -eq 1 ] || die "the signed SHA256SUMS names more than one archive for $target"
  want=${line%%  *}
  name=${line#*  }
  version=${name#dovet-}
  version=${version%-"$target".tar.gz}

  fetch "$base/$name" "$tmp/$name"
  [ "$(sha256_of "$tmp/$name")" = "$want" ] || die "the checksum of $name does not match the signed SHA256SUMS"

  tar -tzf "$tmp/$name" | awk '$0 !~ /^dovet(\/|$)/ || $0 ~ /(^|\/)\.\.(\/|$)/ { bad = 1 } END { exit bad }' ||
    die "the archive holds a file outside dovet/"
  if tar -tvzf "$tmp/$name" | grep -q '^[lh]'; then die "the archive holds a link"; fi

  mkdir -p "$root/versions" "$bindir"
  scratch=$(mktemp -d "$root/versions/.new-XXXXXX")
  tar -xzf "$tmp/$name" -C "$scratch" --no-same-owner
  [ -x "$scratch/dovet/dovet" ] || die "the archive has no dovet/dovet"

  dest="$root/versions/$version"
  if [ -e "$dest" ]; then mv "$dest" "$scratch/replaced"; fi
  mv "$scratch/dovet" "$dest"

  if [ -e "$root/current" ] && [ ! -L "$root/current" ]; then die "$root/current exists and is not a link"; fi
  if [ -L "$root/current" ]; then
    left=$(basename "$(readlink "$root/current")")
    if [ "$left" != "$version" ]; then echo "$left" >"$root/previous"; fi
  fi
  ln -sfn "versions/$version" "$root/current"

  if [ -e "$bindir/dovet" ] && [ ! -L "$bindir/dovet" ]; then die "$bindir/dovet exists and is not a link"; fi
  ln -sfn "$root/current/dovet" "$bindir/dovet"

  echo "Installed dovet $version in $root"
  case ":$PATH:" in
    *":$bindir:"*) ;;
    *)
      case $bindir in
        "$HOME"/*) shown="\$HOME/${bindir#"$HOME"/}" ;;
        *) shown=$bindir ;;
      esac
      echo "$bindir is not on your PATH. Add this line to your shell's startup file (dovet never edits it):"
      echo "  export PATH=\"$shown:\$PATH\""
      ;;
  esac
}

main "$@"
