/**
 * 毎日英単語テスト
 *
 * 「単語テスト.pdf」の単語を掲載順に 1 日 30 問ずつ出題し、1 日に 3 本のテストを課す。
 *   1. 今日のテスト          … 未出題の 30 語
 *   2. 前日のテスト（強制）  … 前回受けた日とまったく同じ 30 問
 *   3. 間違い直しテスト      … 1 と 2 で間違えた問題だけ
 * 1 が終わるまで 2 は開けず、2 が終わるまで 3 は開けない。
 *
 * 保存先は localStorage のみ（サーバーなし）。保存しているデータの形は次の通り。
 *
 *   "vocab.users"             { "<メールアドレス>": { email, nickname, since } }
 *   "vocab.lastEmail"         "<メールアドレス>"            … 自動ログイン用
 *   "vocab.progress.<メール>" Progress
 *
 *   Progress = {
 *     version:       保存形式の版。古い版は読み捨てる
 *     nextWordIndex: 次のテストで出す先頭の単語（WORDS の添字）
 *     days:          { "YYYY-MM-DD": Day }
 *     mistakeCounts: { "<英単語>": { count, lastDate } }  … 間違えた回数
 *     createdAt:     "YYYY-MM-DD"
 *   }
 *   Day  = { wordIndexes: number[], previousDate: string|null, tests: { [テストID]: Test } }
 *   Test = { questions: Question[], finished: boolean,
 *            skipped?, noMistakes?, sourceDate?, finishedAt? }
 *   Question = { wordIndex, format, choices: string[4], answerIndex, chosenIndex: number|null }
 */
(function () {
  'use strict';

  /* ============================================================ 設定・定数 */

  var WORDS = window.WORDS || [];          // words.js が入れる { no, page, en, ja } の配列
  var WORD_COUNT = WORDS.length;

  var QUESTIONS_PER_TEST = 30;             // 1 日に出す語数。一巡の最後の日だけ、余った語数になる
  var CHOICE_COUNT = 4;                    // 選択肢の数

  /** 出題形式。英単語を見せて意味を選ばせるか、その逆か。 */
  var ASK_MEANING = 'askMeaning';
  var ASK_WORD = 'askWord';

  /** 1 日に受ける 3 本のテスト。この順に受けなければならない。 */
  var TESTS = [
    { id: 'today',    badge: '1', title: '今日のテスト' },
    { id: 'previous', badge: '2', title: '前日のテスト（強制）' },
    { id: 'mistakes', badge: '3', title: '間違い直しテスト' }
  ];
  var TEST_IDS = TESTS.map(function (test) { return test.id; });

  function testInfo(testId) {
    return TESTS.filter(function (test) { return test.id === testId; })[0];
  }

  /** 英単語から単語データを引くための索引（間違い回数は英単語をキーに保存するため）。 */
  var WORD_BY_EN = {};
  WORDS.forEach(function (word) { WORD_BY_EN[word.en] = word; });

  /** 訳から単語データを引くための索引（選択肢に反対側を並べて書くため）。 */
  var WORD_BY_JA = {};
  WORDS.forEach(function (word) { WORD_BY_JA[word.ja] = word; });

  /**
   * 選択肢に書いてある文字列から、その語の反対側を返す。
   * 意味を選ぶ問題なら英単語、単語を選ぶ問題なら訳。
   * 単語リストには同じ英単語も同じ訳もないので、文字列から一意に引ける。
   */
  function choiceCounterpart(text, format) {
    var word = format === ASK_MEANING ? WORD_BY_JA[text] : WORD_BY_EN[text];
    if (!word) return '';
    return format === ASK_MEANING ? word.en : word.ja;
  }

  /* ------------------------------------------------------------ 品詞 */

  /*
   * 4 択は同じ品詞でそろえる。品詞が混ざると、意味の形を見るだけで答えが
   * 絞れてしまうため（動詞の問題に名詞の選択肢が 3 つ並ぶ、など）。
   *
   * 品詞は意味の書き方から見分ける。
   *   「〜を」「〜に」で始まる     → 動詞
   *   「〜な」「〜の」「〜い」で終わる → 形容詞
   *   「〜に」「〜と」で終わる      → 副詞
   *   どれでもない                 → 名詞
   * 動詞はさらに「〜」が付くかどうかで分ける。付く語だけを並べないと、
   * 「〜」の有無で答えが浮いてしまう。
   */

  /**
   * 英語では形容詞・副詞・名詞なのに、日本語にすると動詞の形になる語。
   * 上の規則では拾えないので、ここに書き出しておく。
   */
  var POS_EXCEPTIONS = {
    bilingual: '形容詞', brilliant: '形容詞', widespread: '形容詞', visible: '形容詞',
    controversial: '形容詞', imaginative: '形容詞', misleading: '形容詞', punctual: '形容詞',
    dizzy: '形容詞', intriguing: '形容詞', perpetual: '形容詞', conspicuous: '形容詞',
    probably: '副詞', nevertheless: '副詞', altogether: '副詞', utterly: '副詞',
    necessarily: '副詞',
    laughter: '名詞', behavior: '名詞', curse: '名詞', junk: '名詞', drought: '名詞',
    trap: '名詞'
  };

  var NOMINALIZER = /(もの|こと|ひと|ところ|とき|人|所|物|事)$/;
  var ADJECTIVE_TAIL = /(できる|ている|がある|のある|にある|に値する)$/;
  var VERB_TAIL = /[うくぐすずつぬふぶむるゆ]$/;

  /** いちばん最初の語義。「〜を捨てる、放棄する」なら「〜を捨てる」。 */
  function firstSense(ja) {
    return ja.split('、')[0].replace(/（[^）]*）/g, '');
  }

  function partOfSpeech(word) {
    if (POS_EXCEPTIONS[word.en]) return POS_EXCEPTIONS[word.en];
    var sense = firstSense(word.ja);
    if (NOMINALIZER.test(sense)) return '名詞';
    if (sense.indexOf('〜') >= 0 && /ない$/.test(sense)) return '副詞';   // 「めったに〜ない」
    if (ADJECTIVE_TAIL.test(sense) || /[なのいた]$/.test(sense)) return '形容詞';
    if (sense.charAt(0) === '〜') return '動詞/〜';
    if (/[にと]$/.test(sense)) return '副詞';
    if (VERB_TAIL.test(sense)) return '動詞/自';
    return '名詞';
  }

  /** 品詞ごとの単語の添字。選択肢はここから選ぶ。 */
  var WORDS_BY_POS = {};
  WORDS.forEach(function (word, index) {
    var pos = partOfSpeech(word);
    (WORDS_BY_POS[pos] = WORDS_BY_POS[pos] || []).push(index);
  });

  /* ============================================================ 保存まわり */

  var USERS_KEY = 'vocab.users';
  var LAST_EMAIL_KEY = 'vocab.lastEmail';
  var PROBE_KEY = 'vocab.probe';
  var PROGRESS_VERSION = 1;

  /**
   * この端末で localStorage が本当に使えるか、起動時に 1 度だけ確かめる。
   * プライベートモードや、保存をブロックするブラウザでは書けても読み戻せないことがある。
   * 気づかないまま使い続けると 1 日分の学習がまるごと消えるので、先に画面で知らせる。
   */
  var storageWorks = (function () {
    try {
      localStorage.setItem(PROBE_KEY, '1');
      var readBack = localStorage.getItem(PROBE_KEY);
      localStorage.removeItem(PROBE_KEY);
      return readBack === '1';
    } catch (error) {
      return false;
    }
  })();

  var saveFailed = false;   // 一度でも保存に失敗したか

  function progressKey(email) {
    return 'vocab.progress.' + email;
  }

  function readJson(key, fallback) {
    try {
      var stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      saveFailed = false;
    } catch (error) {
      // alert は環境によっては出ないので、画面上の警告で知らせる
      saveFailed = true;
    }
  }

  /** Date を "YYYY-MM-DD" にする。日付の比較と days のキーに使う。 */
  function dateKey(date) {
    date = date || new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  /** "2026-11-06" を "11月6日" にする。画面表示用。 */
  function formatDateJa(key) {
    var parts = key.split('-');
    return Number(parts[1]) + '月' + Number(parts[2]) + '日';
  }

  /* ============================================================ 現在の状態 */

  var currentUser = null;   // { email, nickname }
  var progress = null;      // 上のコメントにある Progress
  var screen = { name: 'home' };

  function emptyProgress() {
    return {
      version: PROGRESS_VERSION,
      nextWordIndex: 0,
      days: {},
      mistakeCounts: {},
      createdAt: dateKey()
    };
  }

  /** 保存済みの学習データを読む。形式が古い場合はあきらめて作り直す。 */
  function loadProgress(email) {
    var stored = readJson(progressKey(email), null);
    if (!stored || stored.version !== PROGRESS_VERSION) return emptyProgress();
    if (!stored.days) stored.days = {};
    if (!stored.mistakeCounts) stored.mistakeCounts = {};
    return stored;
  }

  function saveProgress() {
    if (currentUser) writeJson(progressKey(currentUser.email), progress);
  }

  /* ============================================================ 問題の作成 */

  function shuffle(list) {
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var swap = list[i];
      list[i] = list[j];
      list[j] = swap;
    }
    return list;
  }

  /** その出題形式で選択肢に並べる文字列（意味を選ぶなら日本語、単語を選ぶなら英語）。 */
  function choiceTextOf(word, format) {
    return format === ASK_MEANING ? word.ja : word.en;
  }

  /**
   * 1 問作る。ダミーの選択肢だけをランダムに選ぶ。
   * 出題そのものの順番は PDF の掲載順のままで、ここでは入れ替えない。
   */
  function createQuestion(wordIndex, format) {
    var answer = WORDS[wordIndex];
    var sameParts = WORDS_BY_POS[partOfSpeech(answer)];

    // 同じ文字列はもちろん、語義の頭が同じものも避ける。
    // 「〜を捨てる」が 2 つ並ぶと、正解が 2 つあることになってしまう。
    var usedTexts = {};
    var usedSenses = {};
    usedTexts[choiceTextOf(answer, format)] = true;
    usedSenses[firstSense(answer.ja)] = true;

    var pickedIndexes = [wordIndex];
    var attempts = 0;
    while (pickedIndexes.length < CHOICE_COUNT && attempts++ < 800) {
      var candidate = sameParts[Math.floor(Math.random() * sameParts.length)];
      if (candidate === wordIndex) continue;
      var text = choiceTextOf(WORDS[candidate], format);
      var sense = firstSense(WORDS[candidate].ja);
      if (usedTexts[text] || usedSenses[sense]) continue;
      usedTexts[text] = true;
      usedSenses[sense] = true;
      pickedIndexes.push(candidate);
    }
    shuffle(pickedIndexes);

    return {
      wordIndex: wordIndex,
      format: format,
      choices: pickedIndexes.map(function (index) {
        return choiceTextOf(WORDS[index], format);
      }),
      answerIndex: pickedIndexes.indexOf(wordIndex),
      chosenIndex: null
    };
  }

  /**
   * 1 テスト分の問題を作る。前半が英語→意味、後半が意味→英語で、半分ずつに分ける。
   * 一巡の最後の日は 30 語に満たないので、問題数はその日の語数から決める。
   */
  function createQuestions(wordIndexes) {
    var meaningCount = Math.round(wordIndexes.length / 2);
    return wordIndexes.map(function (wordIndex, position) {
      return createQuestion(wordIndex, position < meaningCount ? ASK_MEANING : ASK_WORD);
    });
  }

  /* ============================================================ 1 日の進行 */

  /** 今日の記録を返す。まだなければ作る（今日の 30 語を切り出して先頭位置を進める）。 */
  function todayRecord() {
    var today = dateKey();
    if (progress.days[today]) return progress.days[today];

    var previousDate = Object.keys(progress.days)
      .filter(function (key) { return key < today; })
      .sort()
      .pop() || null;

    // 一巡の区切りを毎回そろえるため、末尾をまたがずにそこで打ち切る。
    // 2034 は 30 で割り切れないので、一巡の最後の日だけ 24 語になる。
    var takeCount = Math.min(QUESTIONS_PER_TEST, WORD_COUNT - progress.nextWordIndex);
    var wordIndexes = [];
    for (var i = 0; i < takeCount; i++) {
      wordIndexes.push(progress.nextWordIndex + i);
    }
    progress.nextWordIndex = (progress.nextWordIndex + takeCount) % WORD_COUNT;

    var previousDay = previousDate ? progress.days[previousDate] : null;
    progress.days[today] = {
      wordIndexes: wordIndexes,
      previousDate: previousDate,
      tests: {
        today: { questions: createQuestions(wordIndexes), finished: false },
        // 前日の記録がなければ受けようがないので、済んだものとして飛ばす
        previous: previousDay
          ? { questions: createQuestions(previousDay.wordIndexes), finished: false, sourceDate: previousDate }
          : { questions: [], finished: true, skipped: true }
      }
    };
    saveProgress();
    return progress.days[today];
  }

  /** 1・2 本目で間違えた問題を、PDF 掲載順に並べて返す。 */
  function mistakeQuestions(day) {
    var seen = {};
    var questions = [];
    ['today', 'previous'].forEach(function (testId) {
      (day.tests[testId].questions || []).forEach(function (question) {
        var wasWrong = question.chosenIndex !== null && question.chosenIndex !== question.answerIndex;
        var key = question.wordIndex + '/' + question.format;
        if (wasWrong && !seen[key]) {
          seen[key] = true;
          questions.push(createQuestion(question.wordIndex, question.format));
        }
      });
    });
    // 1 本目と 2 本目の間違いが混ざるので、ここでも PDF 掲載順に並べ直す
    questions.sort(function (a, b) {
      if (a.wordIndex !== b.wordIndex) return a.wordIndex - b.wordIndex;
      return a.format === b.format ? 0 : (a.format === ASK_MEANING ? -1 : 1);
    });
    return questions;
  }

  /** 3 本目（間違い直し）を組み立てる。1・2 本目が終わってから呼ぶこと。 */
  function buildMistakeTest(day) {
    if (day.tests.mistakes) return day.tests.mistakes;

    var questions = mistakeQuestions(day);
    day.tests.mistakes = {
      questions: questions,
      finished: questions.length === 0,
      noMistakes: questions.length === 0
    };
    saveProgress();
    return day.tests.mistakes;
  }

  /** 今これから受けるべきテストの ID。3 本とも終わっていれば null。 */
  function currentTestId(day) {
    if (!day.tests.today.finished) return 'today';
    if (!day.tests.previous.finished) return 'previous';
    if (!buildMistakeTest(day).finished) return 'mistakes';
    return null;
  }

  function testScore(test) {
    var score = { total: 0, correct: 0, answered: 0 };
    if (!test || !test.questions) return score;
    score.total = test.questions.length;
    test.questions.forEach(function (question) {
      if (question.chosenIndex === null) return;
      score.answered++;
      if (question.chosenIndex === question.answerIndex) score.correct++;
    });
    return score;
  }

  function isDayFinished(day) {
    return TEST_IDS.every(function (testId) {
      return day.tests[testId] && day.tests[testId].finished;
    });
  }

  /** 3 本すべて終えた日が何日続いているか。今日がまだ途中でも途切れた扱いにはしない。 */
  function streakLength() {
    var days = 0;
    var cursor = new Date();
    if (!isDayFinished(progress.days[dateKey(cursor)] || { tests: {} })) {
      cursor.setDate(cursor.getDate() - 1);   // 今日はこれから終わらせる分として数えない
    }
    while (progress.days[dateKey(cursor)] && isDayFinished(progress.days[dateKey(cursor)])) {
      days++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return days;
  }

  /* ============================================================ 画面の土台 */

  var root = document.getElementById('app');

  var HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (char) { return HTML_ESCAPES[char]; });
  }

  /** 画面を切り替える。params は画面ごとの引数（表示するテストやページ番号など）。 */
  function showScreen(name, params) {
    screen = Object.assign({ name: name }, params || {});
    render();
    window.scrollTo(0, 0);
  }

  function onClick(selector, handler) {
    Array.prototype.forEach.call(root.querySelectorAll(selector), function (element) {
      element.addEventListener('click', handler);
    });
  }

  /** data-* 属性に入れた値を読んでハンドラに渡す。 */
  function onClickWithValue(attribute, handler) {
    onClick('[' + attribute + ']', function (event) {
      handler(event.currentTarget.getAttribute(attribute));
    });
  }

  /* ============================================================ 共通の部品 */

  /**
   * この端末では保存できない、という警告。
   * 黙って消えるのがいちばん困るので、どの画面でも先頭に出す。
   */
  function storageWarning() {
    if (storageWorks && !saveFailed) return '';
    return '<div class="warn-box">' +
      '<strong>この端末では学習の記録を保存できません。</strong>' +
      'このままだと、ブラウザを閉じたときに今日の記録が消えます。' +
      'プライベートモード（シークレットモード）を解除するか、別のブラウザで開いてみてください。' +
    '</div>';
  }

  function headerBar() {
    return storageWarning() + '<div class="appbar">' +
      '<div><strong>' + escapeHtml(currentUser.nickname) + '</strong> ' +
        '<span class="badge">連続 ' + streakLength() + ' 日</span>' +
        '<div class="who">' + escapeHtml(currentUser.email) + '</div></div>' +
      '<button class="btn-sm btn-ghost" data-go="logout">ログアウト</button>' +
    '</div>';
  }

  var NAV_ITEMS = [
    { screen: 'home',    label: 'ホーム' },
    { screen: 'wrong',   label: '間違えた単語' },
    { screen: 'browse',  label: '単語一覧' },
    { screen: 'history', label: '履歴' },
    { screen: 'transfer', label: '引き継ぎ' }
  ];

  function navTabs(activeScreen) {
    return '<div class="tabs">' + NAV_ITEMS.map(function (item) {
      var current = item.screen === activeScreen ? ' aria-current="true"' : '';
      return '<button data-go="' + item.screen + '"' + current + '>' + item.label + '</button>';
    }).join('') + '</div>';
  }

  function bindNav() {
    onClickWithValue('data-go', function (target) {
      if (target === 'logout') logout();
      else showScreen(target);
    });
  }

  /**
   * 単語帳の 1 行。
   * leading には行頭に出すもの（◯✗ や回数のバッジ）、trailing には行末に出すものを渡す。
   */
  function wordRow(word, leading, trailing) {
    return '<div class="wb-item">' +
      (leading || '') +
      '<div class="en">' + escapeHtml(word.en) + '</div>' +
      '<div class="ja">' + escapeHtml(word.ja) + '</div>' +
      (trailing || '') +
    '</div>';
  }

  function mistakeBadge(word) {
    var record = progress.mistakeCounts[word.en];
    return record ? '<div class="count-pill">' + record.count + '回</div>' : '';
  }

  /* ============================================================ ログイン画面 */

  function renderLogin() {
    var users = readJson(USERS_KEY, {});
    var knownEmails = Object.keys(users);

    root.innerHTML = storageWarning() +
      '<h1>毎日英単語テスト</h1>' +
      '<p class="muted">「単語テスト.pdf」の ' + WORD_COUNT + ' 語を掲載順に、1 日 ' + QUESTIONS_PER_TEST + ' 問ずつ。</p>' +
      '<div class="card">' +
        '<h2>ログイン</h2>' +
        '<label for="email">メールアドレス</label>' +
        '<input id="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com">' +
        '<div id="loginHint" class="muted stack-top-xs" hidden></div>' +
        '<label for="nickname">ニックネーム<span class="muted">（はじめてのときだけ）</span></label>' +
        '<input id="nickname" type="text" autocomplete="nickname" placeholder="たろう">' +
        '<div id="loginError" class="err" hidden></div>' +
        '<p class="muted stack-top">2 回目からはメールアドレスだけで入れます。' +
          '学習データはこの端末のブラウザ内に保存されます（パスワードはありません）。</p>' +
        '<button id="startButton" class="btn-primary btn-block stack-top-xs">はじめる</button>' +
      '</div>' +
      (knownEmails.length ? knownUsersCard(users, knownEmails) : '');

    bindLoginForm(users);
  }

  function knownUsersCard(users, emails) {
    return '<div class="card"><h2>この端末の記録</h2>' + emails.map(function (email) {
      return '<div class="row between user-row">' +
        '<div><strong>' + escapeHtml(users[email].nickname) + '</strong>' +
          '<div class="muted">' + escapeHtml(email) + '</div></div>' +
        '<button class="btn-sm" data-login="' + escapeHtml(email) + '">続ける</button>' +
      '</div>';
    }).join('') + '</div>';
  }

  /**
   * Enter で送信する。ただし日本語入力の「変換の確定」は送信しない。
   *
   * ローマ字 → スペースで変換 → Enter で確定、という流れの最後の Enter まで
   * 送信として扱うと、ニックネームを打ち終える前に次の画面へ進んでしまう。
   * 変換中かどうかの見分け方はブラウザによって違うので、両方に備える。
   *   Chrome 系 … 確定の Enter 自体に isComposing が立つ
   *   Safari 系 … 先に compositionend が起きてから Enter が来る（isComposing は立たない）
   * 後者は直前に変換が終わったかどうかで見分ける。人が押し直すには短すぎる間隔なので、
   * 本当に送信したい 2 回目の Enter を取りこぼすことはない。
   */
  var COMPOSITION_GRACE_MS = 50;

  function bindEnterToSubmit(input, submit) {
    var composing = false;
    var composedAt = -Infinity;

    input.addEventListener('compositionstart', function () {
      composing = true;
    });
    input.addEventListener('compositionend', function (event) {
      composing = false;
      composedAt = event.timeStamp;
    });
    input.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return;
      if (composing || event.isComposing || event.keyCode === 229) return;
      if (event.timeStamp - composedAt < COMPOSITION_GRACE_MS) return;
      submit();
    });
  }

  function bindLoginForm(users) {
    var emailInput = document.getElementById('email');
    var nicknameInput = document.getElementById('nickname');
    var errorBox = document.getElementById('loginError');
    var hintBox = document.getElementById('loginHint');

    // ニックネームは埋めない。2 回目からは入力しないのがふつうだと分かるように。
    var lastEmail = localStorage.getItem(LAST_EMAIL_KEY);
    if (lastEmail && users[lastEmail]) emailInput.value = lastEmail;

    function savedUser() {
      return users[emailInput.value.trim().toLowerCase()] || null;
    }

    /** 打ち込んだメールアドレスが登録済みかどうかを、その場で知らせる。 */
    function updateHint() {
      var user = savedUser();
      hintBox.hidden = !emailInput.value.trim();
      hintBox.textContent = user
        ? 'おかえりなさい、' + user.nickname + ' さん。ニックネームは入れなくて大丈夫です。'
        : 'はじめての方です。ニックネームも入れてください。';
      nicknameInput.placeholder = user ? '変えたいときだけ入力' : 'たろう';
    }

    function showError(message) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }

    function submit() {
      var email = emailInput.value.trim().toLowerCase();
      var typed = nicknameInput.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return showError('メールアドレスの形式が正しくありません。');
      }

      // 2 回目からはメールアドレスだけでよい。名前は保存してあるものを使う。
      // 打ち込まれていればそちらを優先するので、改名もここでできる。
      var saved = users[email];
      var nickname = typed || (saved && saved.nickname) || '';
      if (!nickname) return showError('はじめての方は、ニックネームも入力してください。');
      login(email, nickname);
    }

    emailInput.addEventListener('input', updateHint);
    updateHint();

    document.getElementById('startButton').addEventListener('click', submit);
    [emailInput, nicknameInput].forEach(function (input) {
      bindEnterToSubmit(input, submit);
    });
    onClickWithValue('data-login', function (email) {
      login(email, users[email].nickname);
    });
  }

  function login(email, nickname) {
    var users = readJson(USERS_KEY, {});
    users[email] = {
      email: email,
      nickname: nickname,
      since: (users[email] && users[email].since) || dateKey()
    };
    writeJson(USERS_KEY, users);
    localStorage.setItem(LAST_EMAIL_KEY, email);

    currentUser = { email: email, nickname: nickname };
    progress = loadProgress(email);
    showScreen('home');
  }

  function logout() {
    currentUser = null;
    progress = null;
    showScreen('login');
  }

  /* ============================================================ ホーム画面 */

  function renderHome() {
    var day = todayRecord();
    var nextTestId = currentTestId(day);
    var finishedCount = TEST_IDS.filter(function (id) {
      return day.tests[id] && day.tests[id].finished;
    }).length;

    root.innerHTML = headerBar() + navTabs('home') +
      '<div class="card">' +
        '<div class="row between card-head">' +
          '<h2>' + formatDateJa(dateKey()) + 'のテスト</h2>' +
          '<span class="muted">' +
            (nextTestId ? '残り ' + (TEST_IDS.length - finishedCount) + ' テスト' : 'すべて完了 🎉') +
          '</span>' +
        '</div>' +
        TEST_IDS.map(function (id) { return testRow(day, id, nextTestId); }).join('') +
      '</div>' +
      startButtonOrFinishedNote(day, nextTestId) +
      statsCard(day);

    bindNav();
    onClickWithValue('data-start', function (testId) {
      showScreen('quiz', { testId: testId, questionIndex: null });
    });
    onClickWithValue('data-result', function (testId) {
      showScreen('result', { testId: testId });
    });
  }

  /** ホームに並ぶ 3 本のテストのうち 1 行分。 */
  function testRow(day, testId, nextTestId) {
    var test = day.tests[testId];
    var score = testScore(test);
    var info = testInfo(testId);
    var isNext = testId === nextTestId;

    var description = testDescription(day, testId, test);
    if (test && test.finished && score.total) {
      description += ' / ' + score.correct + '/' + score.total + ' 正解';
    }

    var action = '';
    if (isNext) {
      action = '<button class="btn-primary btn-sm" data-start="' + testId + '">' +
        (score.answered ? '再開' : '開始') + '</button>';
    } else if (test && test.finished && score.total) {
      action = '<button class="btn-sm" data-result="' + testId + '">単語帳</button>';
    }

    var state = (test && test.finished) ? 'done' : (isNext ? 'active' : '');
    return '<div class="stage ' + state + '">' +
      '<div class="num">' + (test && test.finished ? '✓' : info.badge) + '</div>' +
      '<div class="grow">' +
        '<div class="title">' + info.title + '</div>' +
        '<div class="sub">' + escapeHtml(description) + '</div>' +
      '</div>' +
      '<div class="act">' + action + '</div>' +
    '</div>';
  }

  function testDescription(day, testId, test) {
    if (testId === 'today') {
      var first = WORDS[day.wordIndexes[0]];
      var last = WORDS[day.wordIndexes[day.wordIndexes.length - 1]];
      return first.en + ' 〜 ' + last.en + '（PDF ' + first.page + '〜' + last.page + 'ページ）';
    }
    if (testId === 'previous') {
      if (test.skipped) return '前日のテスト記録がないため、今日はスキップされます。';
      return formatDateJa(test.sourceDate) + ' と同じ ' + test.questions.length + ' 問（' +
        (test.finished ? '完了' : '必須') + '）';
    }
    if (!test) return '①②を終えると、間違えた問題だけが出題されます。';
    if (test.noMistakes) return '間違いなし — 出題する問題はありません。';
    return '①②で間違えた ' + test.questions.length + ' 問';
  }

  function startButtonOrFinishedNote(day, nextTestId) {
    if (!nextTestId) {
      var next = progress.nextWordIndex === 0
        ? WORD_COUNT + ' 語を一巡しました。明日は ' + WORDS[0].en + ' に戻って、はじめから出題されます。'
        : '明日は ' + WORDS[progress.nextWordIndex].en + ' から出題されます。';
      return '<div class="note">今日のテストは ' + TEST_IDS.length + ' 本すべて終わりました。' +
        next + '</div>';
    }
    var label = testScore(day.tests[nextTestId]).answered ? '再開' : '開始';
    return '<button class="btn-primary btn-block" data-start="' + nextTestId + '">' +
      testInfo(nextTestId).title + 'を' + label + 'する</button>';
  }

  function statsCard() {
    var finishedDays = Object.keys(progress.days).filter(function (key) {
      return isDayFinished(progress.days[key]);
    }).length;
    // 今の一巡で何語目まで進んだか。ちょうど一巡し終えた日は全語数を出す。
    var studiedWords = progress.nextWordIndex ||
      (Object.keys(progress.days).length ? WORD_COUNT : 0);
    var mistakeWords = Object.keys(progress.mistakeCounts).length;

    return '<div class="card stack-top"><h2>これまで</h2>' +
      '<div class="score">' +
        '<div><span>' + finishedDays + '</span><small>完了した日</small></div>' +
        '<div><span>' + studiedWords + '</span><small>進んだ語数</small></div>' +
        '<div><span>' + mistakeWords + '</span><small>間違えた単語</small></div>' +
      '</div></div>';
  }

  /* ============================================================ テスト画面 */

  var keyboardHandler = null;

  function renderQuiz() {
    var day = todayRecord();
    var testId = screen.testId;
    var test = testId === 'mistakes' ? buildMistakeTest(day) : day.tests[testId];

    // 受ける順番は固定。順番違いや終了済みのテストを開こうとしたらホームに戻す。
    if (!test || !test.questions.length || test.finished || currentTestId(day) !== testId) {
      showScreen('home');
      return;
    }

    var questionIndex = screen.questionIndex;
    if (questionIndex === null || questionIndex === undefined) {
      questionIndex = firstUnansweredIndex(test);
      screen.questionIndex = questionIndex;
    }

    var question = test.questions[questionIndex];
    var word = WORDS[question.wordIndex];
    var answered = question.chosenIndex !== null;
    var isLast = questionIndex + 1 >= test.questions.length;

    root.innerHTML =
      quizHeader(testId, test) +
      quizProgress(questionIndex, test.questions.length, question) +
      quizPrompt(question, word) +
      choiceButtons(question, answered) +
      (answered ? feedback(question, word, isLast) : '<p class="muted hint">キーボードの 1〜4 でも回答できます</p>');

    bindNav();
    onClickWithValue('data-choice', function (value) {
      answerQuestion(test, question, Number(value));
    });
    var nextButton = document.getElementById('nextQuestion');
    if (nextButton) {
      nextButton.addEventListener('click', function () { goToNextQuestion(test, questionIndex); });
    }
    bindKeyboard(test, question, questionIndex, answered);
  }

  function firstUnansweredIndex(test) {
    for (var i = 0; i < test.questions.length; i++) {
      if (test.questions[i].chosenIndex === null) return i;
    }
    return 0;
  }

  function quizHeader(testId, test) {
    var subtitle = testId === 'previous'
      ? '<div class="who">' + formatDateJa(test.sourceDate) + 'の復習</div>'
      : '';
    // テスト中こそ「保存できていない」ことに気づいてほしいので、ここにも出す
    return storageWarning() + '<div class="appbar">' +
      '<div><strong>' + testInfo(testId).title + '</strong>' + subtitle + '</div>' +
      '<button class="btn-sm btn-ghost" data-go="home">中断</button>' +
    '</div>';
  }

  function quizProgress(questionIndex, total, question) {
    var percent = Math.round((questionIndex / total) * 100);
    return '<div class="qhead">' +
        '<span>第 ' + (questionIndex + 1) + ' 問 / ' + total + ' 問</span>' +
        '<span>' + (question.format === ASK_MEANING ? '英語 → 意味' : '意味 → 英語') + '</span>' +
      '</div>' +
      '<div class="bar"><i style="width:' + percent + '%"></i></div>';
  }

  function quizPrompt(question, word) {
    var askingMeaning = question.format === ASK_MEANING;
    return '<div class="prompt">' +
      '<div class="kind">' + (askingMeaning ? '次の単語の意味は？' : '次の意味を表す単語は？') + '</div>' +
      '<div class="word' + (askingMeaning ? '' : ' ja') + '">' +
        escapeHtml(askingMeaning ? word.en : word.ja) +
      '</div>' +
    '</div>';
  }

  function choiceButtons(question, answered) {
    return '<div class="choices">' + question.choices.map(function (choice, index) {
      var classes = 'choice';
      if (answered && index === question.answerIndex) classes += ' correct';
      else if (answered && index === question.chosenIndex) classes += ' wrong';

      // 回答した後は、選ばなかった選択肢にも反対側を書き足す。
      // 外した 3 語もその場で覚えられるようにするため。
      var counterpart = answered ? choiceCounterpart(choice, question.format) : '';
      var sub = counterpart
        ? '<span class="sub">' + escapeHtml(counterpart) + '</span>'
        : '';

      return '<button class="' + classes + '" data-choice="' + index + '"' +
          (answered ? ' disabled' : '') + '>' +
        '<span class="k">' + (index + 1) + '</span>' + escapeHtml(choice) + sub +
      '</button>';
    }).join('') + '</div>';
  }

  function feedback(question, word, isLast) {
    var correct = question.chosenIndex === question.answerIndex;
    var message = correct
      ? '◯ 正解'
      : '✗ 不正解 — ' + escapeHtml(word.en) + '：' + escapeHtml(word.ja);
    return '<div class="feedback ' + (correct ? 'ok' : 'ng') + '">' + message + '</div>' +
      '<button class="btn-primary btn-block stack-top" id="nextQuestion">' +
        (isLast ? '結果を見る' : '次の問題へ') +
      '</button>';
  }

  /** 1〜4 で回答、Enter／Space で次の問題へ。 */
  function bindKeyboard(test, question, questionIndex, answered) {
    if (keyboardHandler) document.removeEventListener('keydown', keyboardHandler);
    keyboardHandler = function (event) {
      if (screen.name !== 'quiz') return;
      if (!answered && event.key >= '1' && event.key <= String(CHOICE_COUNT)) {
        event.preventDefault();
        answerQuestion(test, question, Number(event.key) - 1);
      } else if (answered && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        goToNextQuestion(test, questionIndex);
      }
    };
    document.addEventListener('keydown', keyboardHandler);
  }

  function answerQuestion(test, question, chosenIndex) {
    if (question.chosenIndex !== null) return;   // 二重回答を防ぐ
    question.chosenIndex = chosenIndex;

    var correct = chosenIndex === question.answerIndex;
    if (!correct) recordMistake(WORDS[question.wordIndex]);
    saveProgress();
    render();
    // 次へ進むのは「次の問題へ」を押したときだけ。勝手には進めない。
  }

  function recordMistake(word) {
    var record = progress.mistakeCounts[word.en] || { count: 0 };
    record.count++;
    record.lastDate = dateKey();
    progress.mistakeCounts[word.en] = record;
  }

  function goToNextQuestion(test, questionIndex) {
    if (questionIndex + 1 < test.questions.length) {
      screen.questionIndex = questionIndex + 1;
      render();
      window.scrollTo(0, 0);
      return;
    }
    test.finished = true;
    test.finishedAt = new Date().toISOString();
    saveProgress();
    showScreen('result', { testId: screen.testId });
  }

  /* ============================================================ 結果（単語帳） */

  function renderResult() {
    var day = todayRecord();
    var test = day.tests[screen.testId];
    if (!test || !test.questions.length) {
      showScreen('home');
      return;
    }

    var score = testScore(test);
    var nextTestId = currentTestId(day);
    var results = resultsByWord(test);

    root.innerHTML =
      '<h1>' + testInfo(screen.testId).title + ' 終了</h1>' +
      '<div class="card"><div class="score">' +
        '<div><span>' + score.correct + '/' + score.total + '</span><small>正解</small></div>' +
        '<div><span>' + Math.round((score.correct / score.total) * 100) + '%</span><small>正答率</small></div>' +
        '<div><span>' + (score.total - score.correct) + '</span><small>間違い</small></div>' +
      '</div></div>' +
      nextTestPrompt(day, nextTestId) +
      '<div class="card stack-top">' +
        '<h2>出題された単語（' + results.length + ' 語）</h2>' +
        '<div class="wb">' + results.map(function (result) {
          var mark = '<div class="mk ' + (result.correct ? 'ok' : 'ng') + '">' +
            (result.correct ? '◯' : '✗') + '</div>';
          return wordRow(result.word, mark, '<div class="pg">p.' + result.word.page + '</div>');
        }).join('') + '</div>' +
      '</div>' +
      '<button class="btn-block stack-top-xs" data-go="home">ホームに戻る</button>';

    bindNav();
    onClickWithValue('data-start', function (testId) {
      showScreen('quiz', { testId: testId, questionIndex: null });
    });
  }

  /** 同じ単語が 2 問に出た場合は 1 行にまとめ、1 つでも間違えていれば ✗ にする。 */
  function resultsByWord(test) {
    var results = [];
    var byWordIndex = {};
    test.questions.forEach(function (question) {
      if (!byWordIndex[question.wordIndex]) {
        byWordIndex[question.wordIndex] = { word: WORDS[question.wordIndex], correct: true };
        results.push(byWordIndex[question.wordIndex]);
      }
      if (question.chosenIndex !== question.answerIndex) {
        byWordIndex[question.wordIndex].correct = false;
      }
    });
    return results;
  }

  function nextTestPrompt(day, nextTestId) {
    if (!nextTestId) {
      return '<div class="note">今日のテストはこれで終わりです。おつかれさまでした 🎉</div>';
    }
    var note = nextTestId === 'mistakes'
      ? '<p class="muted center stack-top-sm">①②で間違えた ' +
          buildMistakeTest(day).questions.length + ' 問が出題されます</p>'
      : '';
    return '<button class="btn-primary btn-block" data-start="' + nextTestId + '">' +
      '続けて ' + testInfo(nextTestId).title + ' へ</button>' + note;
  }

  /* ============================================================ 間違えた単語 */

  function renderWrongWords() {
    var counts = progress.mistakeCounts;
    var entries = Object.keys(counts)
      .filter(function (en) { return WORD_BY_EN[en]; })   // 単語リストから消えた語は飛ばす
      .sort(function (a, b) {
        return counts[b].count - counts[a].count || WORD_BY_EN[a].no - WORD_BY_EN[b].no;
      });

    root.innerHTML = headerBar() + navTabs('wrong') +
      '<div class="card">' +
        '<h2>間違えた単語（' + entries.length + ' 語）</h2>' +
        '<p class="muted">間違えた回数の多い順。テストで間違えるたびに 1 回加算されます。</p>' +
        (entries.length
          ? '<div class="wb">' + entries.map(function (en) {
              var word = WORD_BY_EN[en];
              var badge = '<div class="count-pill">' + counts[en].count + '回</div>';
              return wordRow(word, badge, '<div class="pg">p.' + word.page + '</div>');
            }).join('') + '</div>'
          : '<div class="empty">まだありません。</div>') +
      '</div>';
    bindNav();
  }

  /* ============================================================ 単語一覧 */

  function renderWordList() {
    var currentPage = screen.page || 1;
    var pages = [];
    WORDS.forEach(function (word) {
      if (pages.indexOf(word.page) < 0) pages.push(word.page);
    });
    var wordsOnPage = WORDS.filter(function (word) { return word.page === currentPage; });

    root.innerHTML = headerBar() + navTabs('browse') +
      '<div class="card">' +
        '<h2>単語一覧（PDF 掲載順・' + WORD_COUNT + ' 語）</h2>' +
        '<div class="tabs">' + pages.map(function (page) {
          var current = page === currentPage ? ' aria-current="true"' : '';
          return '<button data-page="' + page + '"' + current + '>' + page + 'p</button>';
        }).join('') + '</div>' +
        '<div class="wb">' + wordsOnPage.map(function (word) {
          return wordRow(word, '<div class="pg">' + word.no + '</div>', mistakeBadge(word));
        }).join('') + '</div>' +
      '</div>';

    bindNav();
    onClickWithValue('data-page', function (page) {
      showScreen('browse', { page: Number(page) });
    });
  }

  /* ============================================================ 履歴 */

  function renderHistory() {
    var dates = Object.keys(progress.days).sort().reverse();

    root.innerHTML = headerBar() + navTabs('history') +
      '<div class="card"><h2>履歴</h2>' +
        (dates.length
          ? '<table class="hist"><tbody>' + dates.map(historyRow).join('') + '</tbody></table>' +
            '<p class="muted stack-top-sm">列は ①今日のテスト ②前日の復習 ③間違い直し</p>'
          : '<div class="empty">まだ記録がありません。</div>') +
      '</div>';
    bindNav();
  }

  function historyRow(date) {
    var day = progress.days[date];
    var cells = TEST_IDS.map(function (testId) {
      var test = day.tests[testId];
      if (!test || test.skipped) return test ? 'skip' : '—';
      if (test.noMistakes) return '—';
      var score = testScore(test);
      return (test.finished ? '' : '…') + score.correct + '/' + score.total;
    });
    return '<tr>' +
      '<td>' + date + (date === dateKey() ? '（今日）' : '') + '</td>' +
      cells.map(function (cell) { return '<td>' + cell + '</td>'; }).join('') +
      '<td>' + (isDayFinished(day) ? '✓' : '') + '</td>' +
    '</tr>';
  }

  /* ============================================================ 引き継ぎ */

  /*
   * 学習の記録はこの端末のブラウザの中にしかない。端末を変えたときや、
   * ブラウザの設定で消えてしまったときに続きから再開できるよう、
   * 進み具合を 1 本の文字列にして持ち出せるようにしておく。
   *
   * 4 択の中身は書き出さない。画面に出るのは単語と意味と ◯✗ だけで、
   * ダミーの選択肢はその場で作り直せるため、持たなくても見た目は変わらない。
   *
   *   VT1|次に出す単語の番号|開始日|日ごとの記録|間違えた回数
   *   日ごとの記録 … 日付,先頭の単語番号,語数,1本目,2本目,3本目   を ";" でつなぐ
   *   各テスト     … "-" 未了 / "s" スキップ / "n" 間違いなし / 間違えた問番号を "." でつないだもの
   */
  var TRANSFER_PREFIX = 'VT1';

  /** 間違えた問題の番号を "." でつないだもの。全問正解なら空文字。 */
  function wrongSpec(test) {
    var wrong = [];
    (test.questions || []).forEach(function (question, index) {
      if (question.chosenIndex !== null && question.chosenIndex !== question.answerIndex) {
        wrong.push(index);
      }
    });
    return wrong.join('.');
  }

  function exportCode() {
    var days = Object.keys(progress.days).sort().map(function (date) {
      var day = progress.days[date];
      var fields = [date, day.wordIndexes[0], day.wordIndexes.length];
      TEST_IDS.forEach(function (testId) {
        var test = day.tests[testId];
        if (!test || !test.finished) fields.push('-');
        else if (test.skipped) fields.push('s');
        else if (test.noMistakes) fields.push('n');
        else fields.push(wrongSpec(test));
      });
      return fields.join(',');
    });

    var mistakes = Object.keys(progress.mistakeCounts).map(function (en) {
      return en + ':' + progress.mistakeCounts[en].count;
    });

    return btoa([
      TRANSFER_PREFIX, progress.nextWordIndex, progress.createdAt,
      days.join(';'), mistakes.join(';')
    ].join('|'));
  }

  /** spec に入っている番号の問題を「間違えた」状態にし、残りを「正解」にする。 */
  function markAnswers(questions, spec) {
    var wrong = {};
    String(spec).split('.').forEach(function (number) {
      if (number !== '') wrong[Number(number)] = true;
    });
    questions.forEach(function (question, index) {
      question.chosenIndex = wrong[index]
        ? (question.answerIndex + 1) % CHOICE_COUNT   // 正解以外ならどれでもよい
        : question.answerIndex;
    });
  }

  function restoreTest(wordIndexes, spec, sourceDate) {
    var test = { questions: createQuestions(wordIndexes), finished: false };
    if (sourceDate) test.sourceDate = sourceDate;
    if (spec === undefined || spec === '-') return test;
    markAnswers(test.questions, spec);
    test.finished = true;
    return test;
  }

  function importCode(code) {
    var payload = atob(String(code).replace(/\s+/g, ''));
    var parts = payload.split('|');
    if (parts[0] !== TRANSFER_PREFIX) throw new Error('形式が違います');

    var restored = {
      version: PROGRESS_VERSION,
      nextWordIndex: Number(parts[1]) || 0,
      days: {},
      mistakeCounts: {},
      createdAt: parts[2] || dateKey()
    };

    var previousDay = null;
    var previousDate = null;

    (parts[3] ? parts[3].split(';') : []).forEach(function (row) {
      var field = row.split(',');
      var date = field[0];
      var start = Number(field[1]);
      var count = Number(field[2]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(count > 0)) return;

      var wordIndexes = [];
      for (var i = 0; i < count; i++) wordIndexes.push((start + i) % WORD_COUNT);

      var day = {
        wordIndexes: wordIndexes,
        previousDate: previousDate,
        tests: {
          today: restoreTest(wordIndexes, field[3]),
          previous: (field[4] === 's' || !previousDay)
            ? { questions: [], finished: true, skipped: true }
            : restoreTest(previousDay.wordIndexes, field[4], previousDate)
        }
      };

      if (field[5] === 'n') {
        day.tests.mistakes = { questions: [], finished: true, noMistakes: true };
      } else if (field[5] !== undefined && field[5] !== '-') {
        var questions = mistakeQuestions(day);
        markAnswers(questions, field[5]);
        day.tests.mistakes = {
          questions: questions,
          finished: true,
          noMistakes: questions.length === 0
        };
      }

      restored.days[date] = day;
      previousDay = day;
      previousDate = date;
    });

    (parts[4] ? parts[4].split(';') : []).forEach(function (entry) {
      var pair = entry.split(':');
      var count = Number(pair[1]);
      if (!pair[0] || !WORD_BY_EN[pair[0]] || !(count > 0)) return;
      restored.mistakeCounts[pair[0]] = { count: count };
    });

    return restored;
  }

  function saveTextFile(name, text) {
    var url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function renderTransfer() {
    root.innerHTML = headerBar() + navTabs('transfer') +
      '<div class="card">' +
        '<h2>記録を持ち出す</h2>' +
        '<p class="muted">このコードを控えておくと、別の端末で続きから始められます。' +
          '記録が消えてしまったときにも、これがあれば元に戻せます。</p>' +
        '<textarea id="exportCode" class="code" rows="4" readonly>' +
          escapeHtml(exportCode()) +
        '</textarea>' +
        '<div class="row stack-top-sm">' +
          '<button class="btn-sm" id="copyCode">コピーする</button>' +
          '<button class="btn-sm" id="saveFile">ファイルに保存</button>' +
          '<span class="muted" id="copyNote"></span>' +
        '</div>' +
      '</div>' +
      '<div class="card">' +
        '<h2>記録を取り込む</h2>' +
        '<p class="muted">持ち出したコードを貼り付けて「取り込む」を押します。' +
          '<strong>この端末にいまある記録は消えます。</strong></p>' +
        '<textarea id="importCode" class="code" rows="4" placeholder="コードを貼り付けてください"></textarea>' +
        '<label class="check"><input type="checkbox" id="importConfirm"> ' +
          'いまの記録を上書きしてよい</label>' +
        '<div class="row stack-top-sm">' +
          '<button class="btn-sm btn-primary" id="runImport">取り込む</button>' +
          '<button class="btn-sm" id="pickFile">ファイルから読み込む</button>' +
          '<input id="importFile" type="file" accept=".txt,text/plain" hidden>' +
        '</div>' +
        '<div id="importError" class="err" hidden></div>' +
      '</div>';
    bindNav();
    bindTransfer();
  }

  function bindTransfer() {
    var codeBox = document.getElementById('exportCode');
    var note = document.getElementById('copyNote');
    var input = document.getElementById('importCode');
    var fileInput = document.getElementById('importFile');
    var errorBox = document.getElementById('importError');

    document.getElementById('copyCode').addEventListener('click', function () {
      codeBox.focus();
      codeBox.select();
      var manual = function () { note.textContent = '選択しました。手でコピーしてください。'; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(codeBox.value).then(function () {
          note.textContent = 'コピーしました。';
        }, manual);
      } else {
        manual();
      }
    });

    document.getElementById('saveFile').addEventListener('click', function () {
      saveTextFile('英単語テスト_引き継ぎ_' + dateKey() + '.txt', codeBox.value);
    });

    document.getElementById('pickFile').addEventListener('click', function () {
      fileInput.click();
    });

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () { input.value = String(reader.result).trim(); };
      reader.readAsText(file);
    });

    document.getElementById('runImport').addEventListener('click', function () {
      errorBox.hidden = true;
      var showError = function (message) {
        errorBox.textContent = message;
        errorBox.hidden = false;
      };
      if (!document.getElementById('importConfirm').checked) {
        return showError('上書きの確認にチェックを入れてください。');
      }
      var restored;
      try {
        restored = importCode(input.value);
      } catch (error) {
        return showError('コードを読み取れませんでした。全体をもう一度貼り付けてください。');
      }
      if (!Object.keys(restored.days).length) {
        return showError('コードに学習の記録が入っていません。');
      }
      progress = restored;
      saveProgress();
      showScreen('home');
    });
  }

  /* ============================================================ 画面の振り分け */

  var SCREENS = {
    login:   renderLogin,
    home:    renderHome,
    quiz:    renderQuiz,
    result:  renderResult,
    wrong:   renderWrongWords,
    browse:  renderWordList,
    history: renderHistory,
    transfer: renderTransfer
  };

  function render() {
    if (!currentUser) {
      renderLogin();
      return;
    }
    (SCREENS[screen.name] || renderHome)();
  }

  /* ============================================================ 起動 */

  function restoreLastSession() {
    var lastEmail = localStorage.getItem(LAST_EMAIL_KEY);
    var users = readJson(USERS_KEY, {});
    if (!lastEmail || !users[lastEmail]) return;
    currentUser = { email: lastEmail, nickname: users[lastEmail].nickname };
    progress = loadProgress(lastEmail);
  }

  restoreLastSession();
  render();
})();
