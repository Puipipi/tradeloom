import 'package:dsh_app/ui/tavern/tavern_vn_view.dart';
import 'package:flutter_test/flutter_test.dart';

/// [n] sentences of about 25 characters each.
String _sentences(int n) => List.generate(n, (i) => '第$i句，她把杯子推过来，炉火在她眼里跳了一下。').join();

int _count(String text, String c) => c.allMatches(text).length;

void main() {
  test('a paragraph that fits is one page', () {
    expect(tavernParagraphPages('她笑了笑。「进来吧。」'), ['她笑了笑。「进来吧。」']);
  });

  test('a long paragraph is cut at the ends of sentences, each page fitting the box', () {
    final paragraph = _sentences(12);
    final pages = tavernParagraphPages(paragraph);
    expect(pages.length, greaterThan(1));
    expect(pages.join(), paragraph); // nothing lost, nothing added
    for (final page in pages) {
      expect(page.length, lessThanOrEqualTo(tavernPageChars + 30));
      expect(page, endsWith('。'));
    }
  });

  test('never inside a quote or an *action*: each page colours as it would whole', () {
    final quote = '「${_sentences(3)}」';
    final action = '*${_sentences(3)}*';
    final paragraph = '${_sentences(2)}$quote${_sentences(2)}$action${_sentences(2)}';
    final pages = tavernParagraphPages(paragraph);
    expect(pages.join(), paragraph);
    for (final page in pages) {
      expect(_count(page, '「'), _count(page, '」'), reason: page);
      expect(_count(page, '*').isEven, isTrue, reason: page);
    }
    expect(pages.any((p) => p.contains(quote)), isTrue); // the long quote, whole
  });

  test('a quote that ends a sentence may end a page; tags, code and tables stay whole', () {
    final pages = tavernParagraphPages('${_sentences(4)}「好。」${_sentences(4)}');
    expect(pages.join(), '${_sentences(4)}「好。」${_sentences(4)}');

    final tagged = '${_sentences(3)}<span title="一。二。三。">${_sentences(3)}</span>${_sentences(3)}';
    for (final page in tavernParagraphPages(tagged)) {
      expect(_count(page, '<'), _count(page, '>'), reason: page);
    }

    final table = '| a | b |\n|---|---|\n| ${_sentences(8)} | x |';
    expect(tavernParagraphPages(table), [table]);
  });

  test('a sentence longer than a page is one page; a few last words join the page before', () {
    final long = '${'很长' * 80}。';
    expect(tavernParagraphPages('$long短。'), ['$long短。']);
  });
}
