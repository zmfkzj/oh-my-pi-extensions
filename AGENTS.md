이 저장소(/home/arthur/Code/oh-my-pi-extensions)가 개발 원본이다. 수정은 여기 각 submodule 디렉터리(예: orche/)에서 한다. ~/.pi/agent/git/github.com/zmfkzj/oh-my-pi-extensions/ 는 Pi 설치본(update 때 원격 기준으로 되돌아감)이므로 수정하지 않는다. 설치본 반영은 submodule·umbrella commit/push 후 `pi update --extensions`로 한다(commit/push는 작업에 주어진 git 권한을 따른다).
submodule 업데이트/commit/push 이후 자동으로 umbrella package도 업데이트/commit/push 수행.
