import pytest
from autobid.discovery.browser import connection_step
from autobid.discovery.models import ConnectionStep

@pytest.mark.parametrize("html,expected", [
    ('<form><input type="password"></form>', ConnectionStep.FORM_READY),
    ('<p>Подтвердите электронную почту</p>', ConnectionStep.EMAIL_VERIFICATION),
    ('<p>Введите код из SMS</p>', ConnectionStep.PHONE_VERIFICATION),
    ('<iframe src="https://smartcaptcha.yandexcloud.net/checkbox"></iframe>', ConnectionStep.HUMAN_CHECK),
    ('<p>Я соглашаюсь с условиями Пользовательского соглашения</p>', ConnectionStep.TERMS_CONFIRMATION),
    ('<h1>Спасибо</h1>', ConnectionStep.NOT_STARTED),
])
def test_connection_steps_never_infer_success_from_form_submission(html, expected):
    assert connection_step(html) == expected


def test_authenticated_marker_must_be_positive_and_same_site():
    assert connection_step('<a href="/account/logout/">Выйти</a>') == ConnectionStep.AUTHENTICATED
    assert connection_step('<a href="https://attacker.test/account/logout/">Выйти</a>') != ConnectionStep.AUTHENTICATED
    assert connection_step('<div>Выйти</div>') != ConnectionStep.AUTHENTICATED

