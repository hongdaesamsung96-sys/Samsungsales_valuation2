# 매장 분석 앱 - 실제 APK 빌드 가이드

이 문서는 `store_app/web` 폴더에 이미 완성되어 있는 웹앱(로그인 + 상담사용 화면 + 본사/지사 관리자용
데이터 분석 화면)을 실제 안드로이드 `.apk` 파일로 감싸는 절차다. 이 프로토타입 환경은 네트워크가
제한돼 있어 Android SDK와 npm 패키지를 직접 받을 수 없기 때문에, 인터넷이 되는 개발 PC(Windows/Mac)에서
아래 순서대로 진행하면 된다.

**중요**: 이 앱은 로그인이 필수라 반드시 `server/sync_server.py`(또는 이를 대체할 실제 운영 서버)가
떠 있어야 동작한다. 로그인 전에는 앱이 세그먼트/스크립트 같은 비민감 참고자료만 오프라인으로 보여주고,
매장별 분석 데이터는 로그인 이후 서버에서 역할에 맞게 받아온다. 운영 서버 배포 시 `sync_server.py`의
`SECRET_KEY`(현재 데모용 하드코딩 값)를 반드시 환경변수로 바꾸고, `ACCOUNTS`의 데모 계정은 사내
SSO/사번 인증으로 교체해야 한다 (자세한 내용은 `AI_상담로그_파이프라인_설계.md` 3-6절 참고).

## 0. 준비물

- Node.js 18 이상 (https://nodejs.org)
- JDK 17
- Android Studio (Android SDK, 빌드도구, 커맨드라인 도구 포함) - https://developer.android.com/studio
- 이 폴더 전체(`store_app/`)를 개발 PC로 복사

## 1. 패키지 설치

```bash
cd store_app
npm install
```

`package.json`에 `@capacitor/core`, `@capacitor/android`, `@capacitor/cli`가 이미 정의돼 있어 이 한 줄이면
필요한 패키지가 전부 받아진다.

## 2. Android 프로젝트 생성

```bash
npx cap add android
```

`capacitor.config.json`이 이미 준비돼 있어(`webDir: "web"`) 별도 설정 없이 바로 `android/` 폴더가 생성되고
`web/` 폴더 내용이 그 안으로 복사된다.

## 3. 서버 주소 설정

`web/js/config.js` 파일 하나만 수정하면 된다.

```js
window.STORE_APP_API_BASE = "https://store-sync.company-internal.com";
```

이 값을 비워두면(`""`) 서버 연동 없이 앱 내장 데이터만으로 오프라인 동작한다. 매장/버전별로 다른 서버를 붙이고
싶으면 이 파일만 교체 후 4번부터 다시 빌드하면 된다.

## 4. 웹 자산 동기화

```bash
npx cap sync android
```

`web/` 폴더를 수정할 때마다 이 명령을 실행해 `android/app/src/main/assets/public`에 반영해야 한다.

## 5. 앱 아이콘/이름 확인

`web/manifest.json`과 `capacitor.config.json`의 `appName`, `appId`가 이미 설정돼 있음
(`com.samsungretail.storeanalysis`). 필요 시 회사 정책에 맞는 패키지명으로 변경 후 3~4번 반복.

## 6. 디버그 APK 빌드 (테스트용, 서명 불필요)

```bash
cd android
./gradlew assembleDebug
```

결과물: `android/app/build/outputs/apk/debug/app-debug.apk`
이 파일을 태블릿에 그대로 옮겨 "출처를 알 수 없는 앱 설치" 허용 후 설치하면 바로 테스트 가능.

## 7. 정식 배포용 서명 APK

사내 배포(스토어 미등록, 사이드로딩)든 Play Store 등록이든 서명이 필요하다.

```bash
# 키스토어 생성 (최초 1회, 안전하게 보관)
keytool -genkeypair -v -keystore store-app-release.keystore \
  -alias store-app -keyalg RSA -keysize 2048 -validity 10000

# android/gradle.properties 에 아래 추가
STORE_FILE=../store-app-release.keystore
STORE_PASSWORD=****
KEY_ALIAS=store-app
KEY_PASSWORD=****
```

`android/app/build.gradle`의 `signingConfigs`/`buildTypes.release`에 위 값을 연결한 뒤:

```bash
./gradlew assembleRelease
```

결과물: `android/app/build/outputs/apk/release/app-release.apk`

## 8. 배포 방식 선택

- **사내 사이드로딩(권장, 가장 빠름)**: MDM(모바일 기기 관리) 툴이나 사내 다운로드 페이지로 apk 배포, 태블릿에서
  "출처를 알 수 없는 앱" 허용 후 설치. 업데이트도 새 apk 재배포로 처리.
- **Google Play 비공개 트랙**: 사내 전용으로 배포하고 싶으면 Play Console에 비공개 트랙으로 올려 초대된
  기기에서만 설치되게 할 수 있음. 심사 절차가 있어 배포 속도는 느려짐.
- **완전 자체 MDM(삼성 Knox Manage 등)**: 매장 태블릿이 삼성 기기라면 Knox Manage로 앱 강제 설치·업데이트·
  원격관리까지 가능해 전국 매장 배포에는 이 방식이 가장 잘 맞음.

## 9. 이후 유지보수 흐름

1. `web/` 폴더 내용 수정 (기능 추가, 디자인 변경 등)
2. `npx cap sync android`
3. `./gradlew assembleRelease`
4. 새 apk를 배포 채널(Knox Manage/사내 MDM/Play 비공개트랙)에 업로드

DB 스키마나 API 응답 구조를 바꿀 때는 `server/sync_server.py`(참조 구현)와 `web/js/app.js`의 데이터
접근 부분을 함께 맞춰야 한다.

## 참고: 이 프로토타입에서 이미 검증된 것

- `web/` 폴더는 로컬 정적 서버로 서빙 테스트 완료 (index.html, app.js, style.css, store_data.json 모두 200 응답)
- `server/sync_server.py`는 실제 기동해 `/api/health`, `/api/full_export`, `/api/store/<id>`,
  `POST /api/sales_talk_log` 4개 엔드포인트 모두 정상 동작 확인 완료
- 위 과정에서 이 두 컴포넌트를 그대로 Capacitor로 감싸기만 하면 되므로, 실제 빌드 단계에서 앱 로직 자체를
  다시 손볼 필요는 없음. Android SDK/Gradle 다운로드만 인터넷 되는 환경에서 진행하면 된다.
