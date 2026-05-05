<?php
class DemoComponent
{
    public function executeComponent(): void {}
}

function demo_helper(string $name): string
{
    return $name;
}

define('DEMO_FLAG', true);
AddEventHandler('main', 'OnBeforeProlog', ['Demo', 'handler']);
$APPLICATION->IncludeComponent('bitrix:news.list', '', []);
