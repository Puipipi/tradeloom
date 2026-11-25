import 'dart:convert';

import 'package:flutter/services.dart';

import 'island_recipes.dart';

/// The scripts and styles an island injects, read once per app run:
/// `assets/web/dsh_web_open.js` (the 网页版's open bridge, read only),
/// `assets/islands/island.js`, `island.css` with the App's code font, and
/// `recipes.json`.
class IslandAssets {
  IslandAssets({AssetBundle? bundle}) : _bundle = bundle ?? rootBundle;

  /// The app-wide set.
  static final shared = IslandAssets();

  final AssetBundle _bundle;

  Future<String>? _open;
  Future<String>? _runtime;
  Future<String>? _css;
  Future<IslandRecipeBook>? _recipes;

  Future<String> _text(String path) => _bundle.loadString('assets/$path', cache: false);

  Future<String> get openBridge => _open ??= _text('web/dsh_web_open.js');

  Future<String> get runtime => _runtime ??= _text('islands/island.js');

  /// island.css plus JetBrains Mono: DSH's code font stack finds nothing on
  /// Android before `Courier` (same as the 网页版's phone layout).
  Future<String> get css => _css ??= () async {
    final font = await _bundle.load('assets/fonts/JetBrainsMono-Regular.ttf');
    final data = base64Encode(font.buffer.asUint8List(font.offsetInBytes, font.lengthInBytes));
    final face =
        '@font-face{font-family:"JetBrains Mono";font-weight:400;font-style:normal;font-display:swap;'
        'src:url(data:font/ttf;base64,$data) format("truetype")}\n';
    return face + await _text('islands/island.css');
  }();

  Future<IslandRecipeBook> get recipes => _recipes ??= _text('islands/recipes.json').then(IslandRecipeBook.parse);
}
