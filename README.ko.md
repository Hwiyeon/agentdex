<p align="left"><a href="./README.md">English</a> | <strong>한국어</strong></p>

# PokéAgent-Safari

![PokéAgent-Safari overworld](imgs/overworld.jpg)

> *Claude Code agent들이 포켓몬이 됩니다.*
>
> *Gotta Monitor 'Em All!*

`poke-agent-safari`는 Claude Code agent를 위한 라이브 웹 대시보드입니다.

실행 중인 세션마다 포켓몬 하나가 배정되고, 작은 섬 위에 올라갑니다. 지금 어떤 agent가 일하고 있는지, 어디서 기다리고 있는지, 어떤 세션이 토큰을 제일 빠르게 태우고 있는지를 한눈에 볼 수 있습니다.

## 한눈에 보기

- `Active Pokemon` — 지금 내 머신에서 동작 중인 Claude Code agent들
- `HP` — 해당 세션에 남아 있는 context window 잔량
- `EXP` 와 `LV` — 토큰 사용량을 RPG 스타일 진행도로 표현한 값
- `Status` — thinking, tool, outputting, waiting, sleeping 중 어떤 상태인지 표시
- `Pokedex` — 지금까지 스폰한 모든 포켓몬을 기록하는 도감

## Recent Updates

- **HP bar가 context compression threshold를 반영합니다.** Claude Code 설정 또는 환경 변수에 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`가 지정되어 있으면, HP가 원본 모델 context 한계가 아니라 해당 auto-compaction threshold에서 0이 됩니다 — Claude Code가 auto-compact하기 전까지 실제로 사용 가능한 context를 HP가 추적합니다.

## 목차

- [Recent Updates](#recent-updates)
- [필드 가이드](#필드-가이드)
  - [Island](#island)
  - [Agents Panel](#agents-panel)
  - [Pokedex](#pokedex)
- [설치](#설치)
- [빠른 시작](#빠른-시작)
  - [명령어](#명령어)
  - [Hard Reset](#hard-reset)
- [Mock Mode](#mock-mode)
- [참고](#참고)

## 필드 가이드

### Island

![Island view](imgs/island.jpg)

- 새로운 세션이 시작될 때마다 포켓몬 하나가 월드에 배정됩니다.
    - 포켓몬은 서식지에 맞는 지역에 등장합니다 — 동굴 포켓몬, 초원 포켓몬, 바다 포켓몬이 각자 어울리는 곳에 스폰됩니다.
    - 스폰 확률은 레어도에 따라 가중치가 다르게 적용되어, 흔한 포켓몬이 희귀한 포켓몬보다 훨씬 자주 나옵니다.
- 루트 agent는 맵에 크게 보이고, subagent는 그 근처에 더 작은 아이콘으로 나타납니다.
    - subagent는 부모의 진화 라인 안에서만 나오므로, 같은 포켓몬이거나 이전 진화 단계로 등장합니다.

### Agents Panel

<table>
  <tr>
    <td width="50%"><img src="imgs/pokemon_tab.jpg" alt="Agents panel" /></td>
    <td width="50%"><img src="imgs/status.jpg" alt="Agent status card" /></td>
  </tr>
</table>

- 스폰된 모든 포켓몬은 왼쪽 패널에도 표시되어 현재 active roster를 바로 확인할 수 있습니다.
- status 카드는 하나의 agent를 최근 명령, 마지막 활동, 모델, HP/EXP 진행도로 압축해서 보여줍니다.
- `LV` 와 `EXP` 는 토큰 사용량에 따라 올라갑니다.
- `HP` 는 context window를 소모할수록 줄어듭니다 — 세션을 마무리하고 새로 시작할 타이밍을 가늠하는 데 유용합니다.
- subagent가 소환되면 패널에 부모 기준 hierarchy가 생깁니다.
- 라이브 `watch` 모드에서 루트 agent가 `10분` 동안 조용하면 `Sleeping` 상태로 전환됩니다.
- 총 `8시간` 동안 아무 활동이 없으면 live map에서 빠지고 Box로 들어갑니다.

- Box는 끝난 세션을 아카이브하며 최대 `300`개 기록을 유지합니다.

### Pokedex

![Island Pokedex](imgs/pokedex.jpg)

- 스폰된 모든 포켓몬은 자동으로 Pokedex에 등록됩니다.
- 첫 발견 시 언제 처음 만났는지, 어떤 project·session에서 등장했는지가 기록됩니다.
- subagent로 처음 만난 포켓몬이라면 부모 lineage 정보도 함께 남습니다.
- 도감을 완성해보세요!

## 설치

Ubuntu 기준으로 먼저 필요한 패키지를 설치합니다.

```bash
sudo apt update
sudo apt install -y git nodejs npm
```

그다음 `poke-agent-safari`를 클론하고 포켓몬 sprite를 내려받습니다.

```bash
git clone git@github.com:Hwiyeon/poke-agent-safari.git poke-agent-safari
cd poke-agent-safari
node tools/setup_poke_assets.js
```

- 외부 npm dependency가 없습니다.
- 기본적으로 `~/.claude/projects` 아래의 Claude Code transcript를 감시합니다.
- `setup_poke_assets.js`는 [PokeAPI sprites repository](https://github.com/PokeAPI/sprites)에서 sprite를 내려받아 `public/vendor/pokeapi-sprites`에 저장합니다.

## 빠른 시작
`poke-agent-safari` 디렉토리 안에서 live watcher를 시작하세요.
```bash
node cli.js watch
```

`http://127.0.0.1:8123` 열기.

## 명령어

```bash
node cli.js watch [--port 8123] 
node cli.js mock [--port 8123] 
node cli.js hard-reset [watch|mock]
node cli.js help
```

## Hard Reset

대시보드의 Hard Reset 버튼으로 `watch` 와 `mock` 모두에서 사용할 수 있습니다.

- `watch`: boxed history와 Pokedex 진행도를 지우고, 현재 살아 있는 top-level agent만 화면에 남긴 뒤 watcher를 transcript 끝으로 다시 맞춰 과거 기록이 재생되지 않게 합니다.
- `mock`: mock snapshot과 Pokedex 파일을 지우고 새로운 synthetic scene을 다시 만듭니다.
- `node cli.js hard-reset [watch|mock]` 명령으로도 대시보드 없이 동일하게 초기화할 수 있습니다.

## Mock Mode

실제 Claude 로그가 없어도 됩니다. `mock` 모드는 데모, 스크린샷, UI 테스트용입니다.

```bash
node cli.js mock
```

더 다듬어진 프로모 장면이 필요하다면 `mock` 모드에서 상단의 `Promo Studio`를 열면 됩니다. 원하는 포켓몬을 스폰하고, `Level`, `HP %`, `EXP`, `Status`를 조절하고, custom root agent를 box/unbox 하며, 현재 장면을 PNG로 내보낼 수 있습니다.

Mock 데이터는 모두 로컬 전용이며 실제 transcript 파일은 건드리지 않습니다.

## 참고

- Ubuntu와 macOS에서 테스트했습니다. Node.js 기반이라 다른 환경에서도 동작할 수 있지만 보장하지는 않습니다.
- 현재 Pokedex는 `251`종까지 지원합니다. 추후 업데이트할 예정입니다.
