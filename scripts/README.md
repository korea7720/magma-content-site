# scripts/

## 위키 초안 내보내기

`npm run export:wiki`는 LLM Wiki의 검토된 Markdown 지식 페이지를 블로그 초안으로 옮깁니다.
기본은 미리보기이며 파일을 쓰지 않습니다. 실제 초안을 만들 때만 `--write`를 붙이세요.

```bash
WIKI_PATH="$HOME/wiki" npm run export:wiki
WIKI_PATH="$HOME/wiki" npm run export:wiki -- --write
```

기본 입력은 `$WIKI_PATH`, Hermes의 `${HERMES_HOME:-~/.hermes}/.env`에 설정한 `WIKI_PATH`, 또는 `~/wiki` 순으로 선택합니다. `--source <경로>`로 입력 폴더를 지정할 수도 있습니다.
`entities/`, `concepts/`, `comparisons/`, `queries/`만 읽고 `raw/` 원문 보관함은 건너뜁니다.
기존 파일은 덮어쓰지 않으며, 생성된 글은 `draft: true`라서 사이트에 공개되지 않습니다.
테스트나 다른 검토 폴더에 내보낼 때는 `--output <경로>`를 지정할 수 있습니다.
내보내기 파일은 `AGENTS.md`의 frontmatter 계약을 따릅니다.

실적 리포트를 내보낼 때는 `content/reports/`와 `collection: "reports"` 계약을 사용해야 합니다.
